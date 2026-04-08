import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');

const buildTargets = [
    'packages/big-common',
    'packages/uml-model-server',
    'packages/uml-glsp-server',
    'packages/big-vscode',
    'packages/big-advancedsearch',
    'packages/big-code-generation',
    'packages/big-instance-explorer',
    'packages/big-minimap',
    'packages/big-outline',
    'packages/big-property-palette',
    'packages/big-revision-management',
    'packages/uml-glsp-client',
    'application/vscode'
];

for (const target of buildTargets) {
    await runDevBuild(target);
}

async function runDevBuild(relativeDir) {
    const cwd = path.join(workspaceRoot, relativeDir);
    const packageJson = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
    const scripts = packageJson.scripts ?? {};

    if ('compile' in scripts) {
        await runNpmScript(relativeDir, cwd, 'compile');
    }

    if ('bundle' in scripts) {
        await runNpmScript(relativeDir, cwd, 'bundle');
    }
}

function getNpmCommand() {
    return process.platform === 'win32' ? 'cmd.exe' : 'npm';
}

function getNpmArgs(scriptName) {
    return process.platform === 'win32' ? ['/d', '/s', '/c', `npm run ${scriptName}`] : ['run', scriptName];
}

async function runNpmScript(relativeDir, cwd, scriptName) {
    console.log(`[build-vscode-dev] ${relativeDir} -> ${scriptName}`);

    const child = spawn(getNpmCommand(), getNpmArgs(scriptName), {
        cwd,
        env: process.env,
        stdio: 'inherit'
    });

    const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
        process.exit(exitCode);
    }
}
