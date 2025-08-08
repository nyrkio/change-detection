/* eslint @typescript-eslint/naming-convention: 0 */
/* eslint @typescript-eslint/no-non-null-assertion: 0 */
/* eslint no-useless-escape: 0 */

/* No-token authentication for GitHub Workflows
 *
 * The idea of No-token authentication is that users can use
 * a Github action, and they can identify themselves toward a
 * 3rd party service, without needing to go through a subscription
 * or registration process, or creating and copy pasting tokens.
 * If the Github repo is public, they also don't need to install the
 * 3rd party service as a Github app. For private projects this is necessary
 * to give the service read permission to the workflow metadata and log file.
 *
 * The authentication is based on the client proving to the 3rd party service
 * (nyrkio.com) that it is able to write arbitrary text into the output of
 * a currently running Github workflow. This proves  to the 3rd party service that
 * the connected client is á) the author of the pull request, in the case of
 * the workflow was triggered by a `pull_request` event, or b) the owner of the
 * repo in most other cases.
 *
 *
 * (c) 2025 Nyrkiö Oy / Henrik Ingo
 *
 * MIT licensed as everything else in this repo...
 */

import * as github from '@actions/github';
import * as core from '@actions/core';

import { Config } from './config';
import { NyrkioClient, NoTokenClaim, NoTokenChallenge } from './nyrkioClient';

function isPr(): boolean {
    // if(github.context.payload.pull_request) return true;
    if (github.context.eventName === 'pull_request') return true;
    return false;
}

function getPr(): object {
    core.debug(JSON.stringify(github.context));
    return github.context;
}

function isPush(): boolean {
    if (github.context.eventName === 'push') return true;
    return false;
}

function getPush(): object {
    core.debug(JSON.stringify(github.context));
    return github.context;
}

export async function noTokenHandshake(config: Config): Promise<NyrkioClient | undefined> {
    const client = new NyrkioClient(config);
    try {
        const me = getGithubContext();
        core.debug("111");
        const challenge: NoTokenChallenge | undefined = await client.noTokenHandshakeClaim(me);

        if (challenge === undefined) return undefined;

        console.log(challenge.public_challenge);
        const loggedIn = await client.noTokenHandshakeComplete(challenge.session);
        if (loggedIn) return client;
        console.warn("Shouldn't happen: No error but you're also not logged in properly.");
    } catch (err: any) {
        if (!client.neverFail) {
            core.setFailed('NoTokenHandshake betweeń Github and Nyrkiö failed...');
        } else {
            console.error('NoTokenHandshake betweeń Github and Nyrkiö failed...');
            console.error(
                'Note: never-fail is true. Ignoring this error and continuing. Will exit successfully to keep the build green.',
            );
        }
        if (err & err.toJSON) {
            console.error(err.toJSON());
        } else {
            console.error(JSON.stringify(err));
        }
    }
    return undefined;
}

function generateSecret(): string {
    const a = Math.random();
    const b = Math.random();
    return `NoTokenHandshake-client_secret-${a}${b}`;
}

function getGithubContext(): NoTokenClaim {
    if (isPr()) {
        core.debug("We're a `pull_request`");
        core.debug(JSON.stringify(github.context));
        core.debug("1");
        const username = github.context.actor;
        core.debug("2");
        const client_secret = generateSecret();
        core.debug("3");
        const repo_owner = github.context.payload.repository?.owner?.login;
        core.debug("4");
        const repo_name = github.context.payload.repository?.name;
        core.debug("5");
        const workflow_name = github.context.workflow;
        core.debug("6");
        const event_name = github.context.eventName;
        core.debug("7");
        const run_number = github.context.runNumber;
        core.debug("8");
        const run_id = github.context.runId;
        core.debug("9");
        return {
            username: username,
            client_secret: client_secret,
            repo_owner: repo_owner ? repo_owner : '',
            repo_name: repo_name ? repo_name : '',
            workflow_name: workflow_name,
            event_name: event_name,
            run_number: run_number,
            run_id: run_id,
        };
        // return {
        //     username: github.context.actor,
        //     client_secret: generateSecret(),
        //     repo_owner: github.context.payload.pull_request!.repository.owner.login,
        //     repo_name: github.context.payload.pull_request!.repository.name,
        //     workflow_name: github.context.workflow,
        //     event_name: github.context.eventName,
        //     run_number: github.context.runNumber,
        //     run_id: github.context.runId,
        // };
    }
    if (isPush()) {
        // const repo_name = github.context.payload.repository?.split('/')[1];
        // const repo_owner = github.context.payload.repository?.owner.login;
        // const authData: NoTokenClaim = {
        //     username: repo_owner,
        //     client_secret: generateSecret(),
        //     repo_owner: repo_owner,
        //     repo_name: repo_name,
        //     workflow_name: github.context.workflow!,
        //     event_name: github.context.eventName!,
        //     run_number: github.context.runNumber!,
        //     run_id: github.context.runId!,
        // };
        // if (repo_owner === github.context.payload.push.event.commits![0].committer.username!) {
        //     authData.repo_owner_email = github.context.payload.push.event.commits![0].committer.email!;
        //     authData.repo_owner_full_name = github.context.payload.push.event.commits![0].committer.name!;
        // }
        // return authData;
    }
    getPr(); // Just for debug
    getPush(); // Just for debug
    throw new Error(
        'Only `push` and `pull_request` events are supported by this github action. Specifically, by the NoTokenHandshake.',
    );
}
