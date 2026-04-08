import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');
const watchedScriptNames = ['watch:compile', 'watch:bundle', 'watch'];
const children = new Map();
let shuttingDown = false;
let failed = false;

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

async function listWorkspaceDirectories(pattern) {
    const [baseDir, segment] = pattern.split('/');
    if (segment !== '*') {
        throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }

    const absoluteBaseDir = path.join(workspaceRoot, baseDir);
    const entries = await readdir(absoluteBaseDir, { withFileTypes: true });
    return entries
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(absoluteBaseDir, entry.name));
}

function getWatchScripts(packageJson) {
    const scripts = packageJson.scripts ?? {};
    const selectedScripts = watchedScriptNames.filter(scriptName => scriptName in scripts);

    if (selectedScripts.includes('watch:compile') || selectedScripts.includes('watch:bundle')) {
        return selectedScripts.filter(scriptName => scriptName !== 'watch');
    }

    return selectedScripts;
}

function prefixStream(stream, prefix) {
    if (!stream) {
        return;
    }

    const reader = createInterface({ input: stream });
    reader.on('line', line => {
        console.log(`[${prefix}] ${line}`);
    });
}

async function terminateChild(child) {
    if (child.exitCode !== null || child.killed) {
        return;
    }

    if (process.platform === 'win32') {
        await new Promise(resolve => {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
                stdio: 'ignore'
            });
            killer.on('close', () => resolve());
            killer.on('error', () => resolve());
        });
        return;
    }

    child.kill('SIGTERM');
}

async function shutdown(exitCode) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    await Promise.allSettled([...children.values()].map(terminateChild));
    process.exit(exitCode);
}

async function loadWorkspaceTasks() {
    const rootPackageJson = await readJson(path.join(workspaceRoot, 'package.json'));
    const patterns = rootPackageJson.workspaces ?? [];
    const taskConfigs = [];

    for (const pattern of patterns) {
        const workspaceDirectories = await listWorkspaceDirectories(pattern);

        for (const workspaceDirectory of workspaceDirectories) {
            const packageJsonPath = path.join(workspaceDirectory, 'package.json');
            try {
                const packageJson = await readJson(packageJsonPath);
                const watchScripts = getWatchScripts(packageJson);

                for (const scriptName of watchScripts) {
                    taskConfigs.push({
                        cwd: workspaceDirectory,
                        label: scriptName === 'watch'
                            ? packageJson.name
                            : `${packageJson.name}:${scriptName}`,
                        scriptName
                    });
                }
            } catch {
                // Ignore workspace folders without a package.json.
            }
        }
    }

    return taskConfigs.sort((left, right) => left.label.localeCompare(right.label));
}

function startTask(taskConfig) {
    let child;
    try {
        if (process.platform === 'win32') {
            child = spawn('cmd.exe', ['/d', '/s', '/c', `npm run ${taskConfig.scriptName}`], {
                cwd: taskConfig.cwd,
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } else {
            child = spawn('npm', ['run', taskConfig.scriptName], {
                cwd: taskConfig.cwd,
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        }
    } catch (error) {
        console.error(`[${taskConfig.label}] failed to start: ${error.message}`);
        failed = true;
        void shutdown(1);
        return;
    }

    children.set(taskConfig.label, child);
    prefixStream(child.stdout, taskConfig.label);
    prefixStream(child.stderr, taskConfig.label);

    child.on('exit', async code => {
        children.delete(taskConfig.label);

        if (shuttingDown) {
            return;
        }

        if (code === 0) {
            console.error(`[${taskConfig.label}] exited unexpectedly`);
        } else {
            console.error(`[${taskConfig.label}] exited with code ${code ?? 1}`);
        }

        failed = true;
        await shutdown(code ?? 1);
    });

    child.on('error', async error => {
        children.delete(taskConfig.label);

        if (shuttingDown) {
            return;
        }

        console.error(`[${taskConfig.label}] failed to start: ${error.message}`);
        failed = true;
        await shutdown(1);
    });
}

process.on('SIGINT', async () => {
    await shutdown(failed ? 1 : 0);
});

process.on('SIGTERM', async () => {
    await shutdown(failed ? 1 : 0);
});

const taskConfigs = await loadWorkspaceTasks();

if (taskConfigs.length === 0) {
    console.error('No workspace watch tasks were found.');
    process.exit(1);
}

console.log(`Starting watch for ${taskConfigs.length} tasks...`);
taskConfigs.forEach(startTask);
