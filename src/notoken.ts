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

interface MiniPr {
    actor?: string;
    repository_owner?: string;
    event?: { pull_request: { base: { repo: { name: string } } } };
    workflow?: string;
    event_name?: string;
    run_number?: string;
    run_id?: string;
}

interface MiniPush {
    repository_owner?: string;
    repository?: string;
    workflow?: string;
    event_name?: string;
    run_number?: string;
    run_id?: string;
    event?: { commits?: [{ committer?: { username?: string; email?: string; name?: string } }] };
}

function isPr(): boolean {
    // if(github.context.payload.pull_request) return true;
    if (github.context.payload.event_name === 'pull_request') return true;
    return false;
}

function getPr(): object {
    core.debug(JSON.stringify(github.context.payload));
    return github.context.payload;
}

function isPush(): boolean {
    if (github.context.payload.event_name === 'push') return true;
    return false;
}

function getPush(): object {
    core.debug(JSON.stringify(github.context.payload));
    return github.context.payload;
}

export async function noTokenHandshake(config: Config): Promise<NyrkioClient | undefined> {
    const client = new NyrkioClient(config);
    const me = getGithubContext();
    const challenge: NoTokenChallenge | undefined = await client.noTokenHandshakeClaim(me);

    if (challenge === undefined) return undefined;

    console.log(challenge.public_challenge);
    const loggedIn = await client.noTokenHandshakeComplete(challenge.session);
    if (loggedIn) return client;
    else return undefined;
}

export function getGithubContext(): NoTokenClaim {
    if (isPr()) {
        const context: MiniPr = getPr();
        return {
            username: context.actor!,
            repo_owner: context.repository_owner!,
            repo_name: context.event!.pull_request!.base!.repo!.name!,
            workflow_name: context.workflow!,
            event_name: context.event_name!,
            run_number: context.run_number!,
            run_id: context.run_id!,
        };
    }
    if (isPush()) {
        const context: MiniPush = getPush();

        const repo_name = context.repository!.split('/')[1];

        const authData: NoTokenClaim = {
            username: context.repository_owner!,
            repo_owner: context.repository_owner!,
            repo_name: repo_name,
            workflow_name: context.workflow!,
            event_name: context.event_name!,
            run_number: context.run_number!,
            run_id: context.run_id!,
        };
        if (context.repository_owner! === context.event!.commits![0].committer!.username!) {
            authData.repo_owner_email = context.event!.commits![0].committer!.email!;
            authData.repo_owner_full_name = context.event!.commits![0].committer!.name!;
        }
        return authData;
    }
    throw new Error(
        'Only `push` and `pull_request` events are supported by this github action. Specifically, by the NoTokenHandshake.',
    );
}
