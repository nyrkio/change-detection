import { promises as fs } from 'fs';
import * as path from 'path';
import * as io from '@actions/io';
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as git from './git';
import { Benchmark, BenchmarkResult } from './extract';
import { Config, ToolType } from './config';
import { DEFAULT_INDEX_HTML } from './default_index_html';
import { leavePRComment } from './comment/leavePRComment';
import { leaveCommitComment } from './comment/leaveCommitComment';

export type BenchmarkSuites = { [name: string]: Benchmark[] };
export interface DataJson {
    lastUpdate: number;
    repoUrl: string;
    entries: BenchmarkSuites;
}

export const SCRIPT_PREFIX = 'window.BENCHMARK_DATA = ';
const DEFAULT_DATA_JSON = {
    lastUpdate: 0,
    repoUrl: '',
    entries: {},
};

async function loadDataJs(dataPath: string): Promise<DataJson> {
    try {
        const script = await fs.readFile(dataPath, 'utf8');
        const json = script.slice(SCRIPT_PREFIX.length);
        const parsed = JSON.parse(json);
        core.debug(`Loaded data.js at ${dataPath}`);
        return parsed;
    } catch (err) {
        console.log(`Could not find data.js at ${dataPath}. Using empty default: ${err}`);
        return { ...DEFAULT_DATA_JSON };
    }
}

async function storeDataJs(dataPath: string, data: DataJson) {
    const script = SCRIPT_PREFIX + JSON.stringify(data, null, 2);
    await fs.writeFile(dataPath, script, 'utf8');
    core.debug(`Overwrote ${dataPath} for adding new data`);
}

async function addIndexHtmlIfNeeded(additionalGitArguments: string[], dir: string, baseDir: string) {
    const indexHtmlRelativePath = path.join(dir, 'index.html');
    const indexHtmlFullPath = path.join(baseDir, indexHtmlRelativePath);
    try {
        await fs.stat(indexHtmlFullPath);
        core.debug(`Skipped to create default index.html since it is already existing: ${indexHtmlFullPath}`);
        return;
    } catch (_) {
        // Continue
    }

    await fs.writeFile(indexHtmlFullPath, DEFAULT_INDEX_HTML, 'utf8');
    await git.cmd(additionalGitArguments, 'add', indexHtmlRelativePath);
    console.log('Created default index.html at', indexHtmlFullPath);
}

function biggerIsBetter(tool: ToolType): boolean {
    switch (tool) {
        case 'cargo':
            return false;
        case 'criterion':
            return true;
        case 'go':
            return false;
        case 'gotpc':
            return false;
        case 'benchmarkjs':
            return true;
        case 'benchmarkluau':
            return false;
        case 'pytest':
            return true;
        case 'googlecpp':
            return false;
        case 'catch2':
            return false;
        case 'julia':
            return false;
        case 'jmh':
            return false;
        case 'benchmarkdotnet':
            return false;
        case 'time':
            return false;
        case 'customBiggerIsBetter':
            return true;
        case 'customSmallerIsBetter':
            return false;
        case 'nyrkioJson':
            return false; // This is needed to satisfy compiler. Never happens.
    }
}

interface Alert {
    current: BenchmarkResult;
    prev: BenchmarkResult;
    ratio: number;
}

function findAlerts(curSuite: Benchmark, prevSuite: Benchmark, threshold: number): Alert[] {
    core.debug(`Comparing current:${curSuite.commit.id} and prev:${prevSuite.commit.id} for alert`);

    const alerts = [];
    for (const current of curSuite.benches) {
        const prev = prevSuite.benches.find((b) => b.name === current.name);
        if (prev === undefined) {
            core.debug(`Skipped because benchmark '${current.name}' is not found in previous benchmarks`);
            continue;
        }

        const ratio = getRatio(curSuite.tool, prev, current);

        if (ratio > threshold) {
            core.warning(
                `Performance alert! Previous value was ${prev.value} and current value is ${current.value}.` +
                    ` It is ${ratio}x worse than previous exceeding a ratio threshold ${threshold}`,
            );
            alerts.push({ current, prev, ratio });
        }
    }

    return alerts;
}

function getCurrentRepoMetadata() {
    const { repo, owner } = github.context.repo;
    const serverUrl = git.getServerUrl(github.context.payload.repository?.html_url);
    return {
        name: repo,
        owner: {
            login: owner,
        },
        // eslint-disable-next-line @typescript-eslint/naming-convention
        html_url: `${serverUrl}/${owner}/${repo}`,
    };
}

function floatStr(n: number) {
    if (!Number.isFinite(n)) {
        return `${n > 0 ? '+' : '-'}∞`;
    }

    if (Number.isInteger(n)) {
        return n.toFixed(0);
    }

    if (n > 0.1) {
        return n.toFixed(2);
    }

    return n.toString();
}

function strVal(b: BenchmarkResult): string {
    let s = `\`${b.value}\` ${b.unit}`;
    if (b.range) {
        s += ` (\`${b.range}\`)`;
    }
    return s;
}

function commentFooter(): string {
    const repoMetadata = getCurrentRepoMetadata();
    const repoUrl = repoMetadata.html_url ?? '';
    const actionUrl = repoUrl + '/actions?query=workflow%3A' + encodeURIComponent(github.context.workflow);

    return `This comment was automatically generated by [workflow](${actionUrl}) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`;
}

export function buildComment(
    benchName: string,
    curSuite: Benchmark,
    prevSuite: Benchmark,
    expandableDetails = true,
): string {
    const lines = [
        `# ${benchName}`,
        '',
        expandableDetails ? '<details>' : '',
        '',
        `| Benchmark suite | Current: ${curSuite.commit.id} | Previous: ${prevSuite.commit.id} | Ratio |`,
        '|-|-|-|-|',
    ];

    for (const current of curSuite.benches) {
        let line;
        const prev = prevSuite.benches.find((i) => i.name === current.name);

        if (prev) {
            const ratio = getRatio(curSuite.tool, prev, current);

            line = `| \`${current.name}\` | ${strVal(current)} | ${strVal(prev)} | \`${floatStr(ratio)}\` |`;
        } else {
            line = `| \`${current.name}\` | ${strVal(current)} | | |`;
        }

        lines.push(line);
    }

    // Footer
    lines.push('', expandableDetails ? '</details>' : '', '', commentFooter());

    return lines.join('\n');
}

function buildAlertComment(
    alerts: Alert[],
    benchName: string,
    curSuite: Benchmark,
    prevSuite: Benchmark,
    threshold: number,
    cc: string[],
): string {
    // Do not show benchmark name if it is the default value 'Benchmark'.
    const benchmarkText = benchName === 'Benchmark' ? '' : ` **'${benchName}'**`;
    const title = threshold === 0 ? '# Performance Report' : '# :warning: **Performance Alert** :warning:';
    const thresholdString = floatStr(threshold);
    const lines = [
        title,
        '',
        `Possible performance regression was detected for benchmark${benchmarkText}.`,
        `Benchmark result of this commit is worse than the previous benchmark result exceeding threshold \`${thresholdString}\`.`,
        '',
        `| Benchmark suite | Current: ${curSuite.commit.id} | Previous: ${prevSuite.commit.id} | Ratio |`,
        '|-|-|-|-|',
    ];

    for (const alert of alerts) {
        const { current, prev, ratio } = alert;
        const line = `| \`${current.name}\` | ${strVal(current)} | ${strVal(prev)} | \`${floatStr(ratio)}\` |`;
        lines.push(line);
    }

    // Footer
    lines.push('', commentFooter());

    if (cc.length > 0) {
        lines.push('', `CC: ${cc.join(' ')}`);
    }

    return lines.join('\n');
}

async function leaveComment(commitId: string, body: string, commentId: string, token: string) {
    core.debug('Sending comment:\n' + body);

    const repoMetadata = getCurrentRepoMetadata();
    const pr = github.context.payload.pull_request;

    return await (pr?.number
        ? leavePRComment(repoMetadata.owner.login, repoMetadata.name, pr.number, body, commentId, token)
        : leaveCommitComment(repoMetadata.owner.login, repoMetadata.name, commitId, body, commentId, token));
}

async function handleComment(benchName: string, curSuite: Benchmark, prevSuite: Benchmark, config: Config) {
    const { commentAlways, githubToken } = config;

    if (!commentAlways) {
        core.debug('Comment check was skipped because comment-always is disabled');
        return;
    }

    if (!githubToken) {
        throw new Error("'comment-always' input is set but 'github-token' input is not set");
    }

    core.debug('Commenting about benchmark comparison');

    const body = buildComment(benchName, curSuite, prevSuite);

    await leaveComment(curSuite.commit.id, body, `${benchName} Summary`, githubToken);
}

async function handleAlert(benchName: string, curSuite: Benchmark, prevSuite: Benchmark, config: Config) {
    const { alertThreshold, githubToken, commentOnAlert, failOnAlert, alertCommentCcUsers, failThreshold } = config;

    if (!commentOnAlert && !failOnAlert) {
        core.debug('Alert check was skipped because both comment-on-alert and fail-on-alert were disabled');
        return;
    }

    const alerts = findAlerts(curSuite, prevSuite, alertThreshold);
    if (alerts.length === 0) {
        core.debug('No performance alert found happily');
        return;
    }

    core.debug(`Found ${alerts.length} alerts`);
    const body = buildAlertComment(alerts, benchName, curSuite, prevSuite, alertThreshold, alertCommentCcUsers);
    let message = body;

    if (commentOnAlert) {
        if (!githubToken) {
            throw new Error("'comment-on-alert' input is set but 'github-token' input is not set");
        }
        const res = await leaveComment(curSuite.commit.id, body, `${benchName} Alert`, githubToken);
        const url = res.data.html_url;
        message = body + `\nComment was generated at ${url}`;
    }

    if (failOnAlert) {
        // Note: alertThreshold is smaller than failThreshold. It was checked in config.ts
        const len = alerts.length;
        const threshold = floatStr(failThreshold);
        const failures = alerts.filter((a) => a.ratio > failThreshold);
        if (failures.length > 0) {
            core.debug('Mark this workflow as fail since one or more fatal alerts found');
            if (failThreshold !== alertThreshold) {
                // Prepend message that explains how these alerts were detected with different thresholds
                message = `${failures.length} of ${len} alerts exceeded the failure threshold \`${threshold}\` specified by fail-threshold input:\n\n${message}`;
            }
            throw new Error(message);
        } else {
            core.debug(
                `${len} alerts exceeding the alert threshold ${alertThreshold} were found but` +
                    ` none of them exceeded the failure threshold ${threshold}`,
            );
        }
    }
}

function addBenchmarkToDataJson(
    benchName: string,
    bench: Benchmark,
    data: DataJson,
    maxItems: number | null,
): Benchmark | null {
    const repoMetadata = getCurrentRepoMetadata();
    const htmlUrl = repoMetadata.html_url ?? '';

    let prevBench: Benchmark | null = null;
    data.lastUpdate = Date.now();
    data.repoUrl = htmlUrl;

    // Add benchmark result
    if (data.entries[benchName] === undefined) {
        data.entries[benchName] = [bench];
        core.debug(`No suite was found for benchmark '${benchName}' in existing data. Created`);
    } else {
        const suites = data.entries[benchName];
        // Get last suite which has different commit ID for alert comment
        for (const e of suites.slice().reverse()) {
            if (e.commit.id !== bench.commit.id) {
                prevBench = e;
                break;
            }
        }

        suites.push(bench);

        if (maxItems !== null && suites.length > maxItems) {
            suites.splice(0, suites.length - maxItems);
            core.debug(
                `Number of data items for '${benchName}' was truncated to ${maxItems} due to max-items-in-charts`,
            );
        }
    }

    return prevBench;
}

function isRemoteRejectedError(err: unknown): err is Error {
    if (err instanceof Error) {
        return ['[remote rejected]', '[rejected]'].some((l) => err.message.includes(l));
    }
    return false;
}

async function writeBenchmarkToGitHubPagesWithRetry(
    bench: Benchmark,
    config: Config,
    retry: number,
): Promise<Benchmark | null> {
    const {
        name,
        tool,
        ghPagesBranch,
        ghRepository,
        benchmarkDataDirPath,
        githubToken,
        autoPush,
        skipFetchGhPages,
        maxItemsInChart,
    } = config;
    const rollbackActions = new Array<() => Promise<void>>();

    // FIXME: This payload is not available on `schedule:` or `workflow_dispatch:` events.
    const isPrivateRepo = github.context.payload.repository?.private ?? false;

    let benchmarkBaseDir = './';
    let extraGitArguments: string[] = [];

    if (githubToken && !skipFetchGhPages && ghRepository) {
        benchmarkBaseDir = './benchmark-data-repository';
        await git.clone(githubToken, ghRepository, benchmarkBaseDir);
        rollbackActions.push(async () => {
            await io.rmRF(benchmarkBaseDir);
        });
        extraGitArguments = [`--work-tree=${benchmarkBaseDir}`, `--git-dir=${benchmarkBaseDir}/.git`];
        await git.checkout(ghPagesBranch, extraGitArguments);
    } else if (!skipFetchGhPages && (!isPrivateRepo || githubToken)) {
        await git.pull(githubToken, ghPagesBranch);
    } else if (isPrivateRepo && !skipFetchGhPages) {
        core.warning(
            "'git pull' was skipped. If you want to ensure GitHub Pages branch is up-to-date " +
                "before generating a commit, please set 'github-token' input to pull GitHub pages branch",
        );
    } else {
        console.warn('NOTHING EXECUTED:', {
            skipFetchGhPages,
            ghRepository,
            isPrivateRepo,
            githubToken: !!githubToken,
        });
    }

    // `benchmarkDataDirPath` is an absolute path at this stage,
    // so we need to convert it to relative to be able to prepend the `benchmarkBaseDir`
    const benchmarkDataRelativeDirPath = path.relative(process.cwd(), benchmarkDataDirPath);
    const benchmarkDataDirFullPath = path.join(benchmarkBaseDir, benchmarkDataRelativeDirPath);

    const dataPath = path.join(benchmarkDataDirFullPath, 'data.js');

    await io.mkdirP(benchmarkDataDirFullPath);

    const data = await loadDataJs(dataPath);
    const prevBench = addBenchmarkToDataJson(name, bench, data, maxItemsInChart);

    await storeDataJs(dataPath, data);

    await git.cmd(extraGitArguments, 'add', path.join(benchmarkDataRelativeDirPath, 'data.js'));
    await addIndexHtmlIfNeeded(extraGitArguments, benchmarkDataRelativeDirPath, benchmarkBaseDir);
    await git.cmd(extraGitArguments, 'commit', '-m', `add ${name} (${tool}) benchmark result for ${bench.commit.id}`);

    if (githubToken && autoPush) {
        try {
            await git.push(githubToken, ghRepository, ghPagesBranch, extraGitArguments);
            console.log(
                `Automatically pushed the generated commit to ${ghPagesBranch} branch since 'auto-push' is set to true`,
            );
        } catch (err: unknown) {
            if (!isRemoteRejectedError(err)) {
                throw err;
            }
            // Fall through

            core.warning(`Auto-push failed because the remote ${ghPagesBranch} was updated after git pull`);

            if (retry > 0) {
                core.debug('Rollback the auto-generated commit before retry');
                await git.cmd(extraGitArguments, 'reset', '--hard', 'HEAD~1');

                // we need to rollback actions in order so not running them concurrently
                for (const action of rollbackActions) {
                    await action();
                }

                core.warning(
                    `Retrying to generate a commit and push to remote ${ghPagesBranch} with retry count ${retry}...`,
                );
                return await writeBenchmarkToGitHubPagesWithRetry(bench, config, retry - 1); // Recursively retry
            } else {
                core.warning(`Failed to add benchmark data to '${name}' data: ${JSON.stringify(bench)}`);
                throw new Error(
                    `Auto-push failed 3 times since the remote branch ${ghPagesBranch} rejected pushing all the time. Last exception was: ${err.message}`,
                );
            }
        }
    } else {
        core.debug(
            `Auto-push to ${ghPagesBranch} is skipped because it requires both 'github-token' and 'auto-push' inputs`,
        );
    }

    return prevBench;
}

async function writeBenchmarkToGitHubPages(bench: Benchmark, config: Config): Promise<Benchmark | null> {
    const { ghPagesBranch, skipFetchGhPages, ghRepository, githubToken } = config;
    if (!ghRepository) {
        if (!skipFetchGhPages) {
            await git.fetch(githubToken, ghPagesBranch);
        }
        await git.cmd([], 'switch', ghPagesBranch);
    }
    try {
        return await writeBenchmarkToGitHubPagesWithRetry(bench, config, 10);
    } finally {
        if (!ghRepository) {
            // `git switch` does not work for backing to detached head
            await git.cmd([], 'checkout', '-');
        }
    }
}

async function loadDataJson(jsonPath: string): Promise<DataJson> {
    try {
        const content = await fs.readFile(jsonPath, 'utf8');
        const json: DataJson = JSON.parse(content);
        core.debug(`Loaded external JSON file at ${jsonPath}`);
        return json;
    } catch (err) {
        core.warning(
            `Could not find external JSON file for benchmark data at ${jsonPath}. Using empty default: ${err}`,
        );
        return { ...DEFAULT_DATA_JSON };
    }
}

async function writeBenchmarkToExternalJson(
    bench: Benchmark,
    jsonFilePath: string,
    config: Config,
): Promise<Benchmark | null> {
    const { name, maxItemsInChart, saveDataFile } = config;
    const data = await loadDataJson(jsonFilePath);
    const prevBench = addBenchmarkToDataJson(name, bench, data, maxItemsInChart);

    if (!saveDataFile) {
        core.debug('Skipping storing benchmarks in external data file');
        return prevBench;
    }

    try {
        const jsonDirPath = path.dirname(jsonFilePath);
        await io.mkdirP(jsonDirPath);
        await fs.writeFile(jsonFilePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        throw new Error(`Could not store benchmark data as JSON at ${jsonFilePath}: ${err}`);
    }

    return prevBench;
}

export async function writeBenchmark(bench: Benchmark, config: Config) {
    const { name, externalDataJsonPath } = config;
    const prevBench = externalDataJsonPath
        ? await writeBenchmarkToExternalJson(bench, externalDataJsonPath, config)
        : await writeBenchmarkToGitHubPages(bench, config);

    // Put this after `git push` for reducing possibility to get conflict on push. Since sending
    // comment take time due to API call, do it after updating remote branch.
    if (prevBench === null) {
        core.debug('Alert check was skipped because previous benchmark result was not found');
    } else {
        await handleComment(name, bench, prevBench, config);
        await handleSummary(name, bench, prevBench, config);
        await handleAlert(name, bench, prevBench, config);
    }
}

async function handleSummary(benchName: string, currBench: Benchmark, prevBench: Benchmark, config: Config) {
    const { summaryAlways } = config;

    if (!summaryAlways) {
        core.debug('Summary was skipped because summary-always is disabled');
        return;
    }

    const body = buildComment(benchName, currBench, prevBench, false);

    const summary = core.summary.addRaw(body);

    core.debug('Writing a summary about benchmark comparison');
    core.debug(summary.stringify());

    await summary.write();
}

function getRatio(tool: ToolType, prev: BenchmarkResult, current: BenchmarkResult) {
    if (prev.value === 0 && current.value === 0) return 1;

    return biggerIsBetter(tool)
        ? prev.value / current.value // e.g. current=100, prev=200
        : current.value / prev.value; // e.g. current=200, prev=100
}
