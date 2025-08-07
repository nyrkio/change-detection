/* eslint @typescript-eslint/naming-convention: 0 */

import axios from 'axios';
import * as core from '@actions/core';
import { Config } from './config';

export interface NoTokenSession {
    username: string;
    client_secret: string;
    server_secret: string;
}

export interface NoTokenClaim {
    username: string; // In the case of a push event, this is the repo_owner, but for PRs this is the PR author, or `actor` in the workflow lingo
    client_secret: string;

    repo_owner: string;
    repo_name: string;
    repo_owner_email?: string; // TODO: These aren't in the pull_request payload, but could probably get them from seprately querying data about repo
    repo_owner_full_name?: string; // Otoh would expect users to always use the `push` (post merge) actions for Nyrkiö, since that is our main use case.
    // So we'll get the owner's email there, eventually
    workflow_name: string; // github.workflow
    event_name: string;
    run_number: number;
    run_id: number;
}

// First response from the service we authenticate with
export interface NoTokenChallenge {
    session: NoTokenSession;
    public_challenge: string; // We need to output this string. The service will verify that it shows up in the workflow output.
    claimed_identity: NoTokenClaim;
}

export class NyrkioClient {
    neverFail = false;
    nyrkioApiRoot = 'https://nyrkio.com/api/v0/';
    version = 'v0';
    httpOptions = { headers: { Authorization: '' } };
    noTokenSession: NoTokenSession | undefined;
    noTokenClaim: NoTokenClaim | undefined;
    isRepoOwner = false;

    constructor(config: Config) {
        const { nyrkioApiRoot, nyrkioToken, neverFail } = config;
        this.nyrkioApiRoot = nyrkioApiRoot || this.nyrkioApiRoot;
        if (nyrkioToken) {
            this.httpOptions.headers.Authorization = 'Bearer ' + (nyrkioToken ? nyrkioToken : '');
        }
        this.neverFail = neverFail;
    }

    async noTokenHandshakeClaim(claim: NoTokenClaim): Promise<NoTokenChallenge | undefined> {
        const uri = this.nyrkioApiRoot + 'auth/github/notoken/claim';
        this.noTokenClaim = claim;
        const challenge: NoTokenChallenge = await this._post(uri, claim);
        return challenge ? challenge : undefined;
    }

    async noTokenHandshakeComplete(session: NoTokenSession): Promise<boolean> {
        if (this.noTokenClaim === undefined) {
            throw new Error('You must call noTokenHandshakeClaim() before noTokenHandshakeComplete()');
        }
        const uri = this.nyrkioApiRoot + 'auth/github/notoken/complete';
        const data: any = await this._post(uri, session);
        if (data) {
            this.noTokenSession = session;
            this.httpOptions.headers.Authorization = `Bearer ${session.username}::::${session.client_secret}::::${session.server_secret}`;
            if (this.noTokenClaim.username === this.noTokenClaim.repo_owner) {
                this.isRepoOwner = true;
            }
            return true;
        }
        return false;
    }

    async _post(uri: string, data: any): Promise<any> {
        try {
            console.log(`POST: ${uri}`);

            const response = await axios.post(uri, data, this.httpOptions);
            core.debug('Response from ${uri}: ');
            core.debug(JSON.stringify(response));
            if (response.data) {
                core.debug('--------success-------');
                return response.data;
            } else {
                console.error(`Empty response from ${uri}`);
                return false;
            }
        } catch (err: any) {
            this._error_handler(err, uri);
            return false;
        }
    }

    _error_handler(err: any, uri: string) {
        console.error(
            `POST to ${uri} failed. I'll still try to post the test results. You can always change the settings later.`,
        );
        if (err && err.status === 409) {
            core.debug(`409: ${err.data.detail}`);
        } else {
            if (err & err.toJSON) {
                console.error(err.toJSON());
            } else {
                console.error(JSON.stringify(err));
            }
            if (!this.neverFail) {
                core.setFailed(`POST to ${uri} failed. ${err.status} ${err.code}.`);
            } else {
                console.error(`POST to ${uri} failed. ${err.status} ${err.code}.`);
                console.error(
                    'Note: never-fail is true. Ignoring this error and continuing. Will exit successfully to keep the build green.',
                );
            }
        }
    }
}
