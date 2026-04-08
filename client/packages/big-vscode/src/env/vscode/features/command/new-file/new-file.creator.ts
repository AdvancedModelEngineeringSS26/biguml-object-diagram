/*********************************************************************************
 * Copyright (c) 2023 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/
import type { IDESessionClient } from '@borkdominik-biguml/big-vscode/vscode';
import { TYPES } from '@borkdominik-biguml/big-vscode/vscode';
import { CreateNewFileAction, CreateNewFileResponseAction, type UmlDiagramType } from '@borkdominik-biguml/uml-glsp-server';
import { type Disposable, DisposableCollection } from '@eclipse-glsp/protocol';
import { inject, injectable } from 'inversify';
import URIJS from 'urijs';
import * as vscode from 'vscode';
import { UmlLangugageEnvironment, VSCodeSettings } from '../../../../common/index.js';
import { newDiagramWizard } from './wizard.js';

const nameRegex = /^([\w_-]+\/?)*[\w_-]+$/;

@injectable()
export class NewFileCreator implements Disposable {
    protected toDispose = new DisposableCollection();
    protected readonly fileOpenRetryCount = 10;
    protected readonly fileOpenRetryDelayMs = 100;

    constructor(
        @inject(TYPES.IdeSessionClient)
        protected readonly session: IDESessionClient,
        @inject(TYPES.ExtensionContext)
        protected readonly context: vscode.ExtensionContext
    ) {}

    dispose(): void {
        this.toDispose.dispose();
    }

    async create(targetUri?: vscode.Uri): Promise<void> {
        const workspaces = vscode.workspace.workspaceFolders;
        const workspace = workspaces?.[0];
        if (workspace === undefined) {
            throw new Error('Workspace was not defined');
        }

        const rootUri = targetUri ?? workspace.uri;

        const wizard = await newDiagramWizard(this.context, {
            diagramTypes: UmlLangugageEnvironment.supportedTypes,
            nameValidator: async input => {
                if (!input || input.trim().length === 0) {
                    return 'Name can not be empty';
                }

                if (input.startsWith('/') || input.endsWith('/')) {
                    return 'Path can not start or end with /';
                }

                if (!nameRegex.test(input)) {
                    return 'Invalid input - only [0-9, a-z, A-Z, /, -, _] allowed';
                }

                try {
                    const target = vscode.Uri.joinPath(rootUri, this.diagramTarget(input).folder);
                    const stat = await vscode.workspace.fs.stat(target);
                    if (stat.type === vscode.FileType.Directory) {
                        const files = await vscode.workspace.fs.readDirectory(target);
                        if (files.length > 0) {
                            return 'Provided path is not empty';
                        }
                    }
                } catch (_error) {
                    // No op
                }

                return undefined;
            }
        });

        if (wizard !== undefined) {
            await this.createUmlDiagram(rootUri, wizard.name.trim(), wizard.diagramPick.diagramType);
        }
    }

    protected async createUmlDiagram(rootUri: vscode.Uri, diagramName: string, diagramType: UmlDiagramType): Promise<void> {
        const workspaceRoot = new URIJS(decodeURIComponent(this.rootDestination(rootUri)));
        const modelUri = new URIJS(workspaceRoot + '/' + this.diagramDestination(diagramName));

        const client = await this.session.client();
        client.sendActionMessage({
            action: CreateNewFileAction.create(diagramType, modelUri.path()),
            clientId: client.id
        });
        const dispose = client.onActionMessage(async message => {
            if (CreateNewFileResponseAction.is(message.action)) {
                dispose.dispose();

                vscode.window.showInformationMessage(
                    'Thank you for testing bigUml. We want to remind you that bigUml is at an early stage of development.',
                    'Close'
                );
                await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
                const createdFile = this.toFileUri(message.action.sourceUri);
                await this.prepareCustomEditorDocument(createdFile);
                await vscode.commands.executeCommand('vscode.openWith', createdFile, VSCodeSettings.editor.viewType);
            }
        }, client.id);
    }

    protected toFileUri(sourceUri: string): vscode.Uri {
        return sourceUri.startsWith('file:')
            ? vscode.Uri.parse(sourceUri.endsWith('.uml') ? sourceUri : `${sourceUri}.uml`)
            : vscode.Uri.file(`${sourceUri}.uml`);
    }

    protected async prepareCustomEditorDocument(uri: vscode.Uri): Promise<void> {
        let lastError: unknown;

        // Files are created by the server process, so VS Code can lag briefly before it can resolve the document.
        for (let attempt = 0; attempt < this.fileOpenRetryCount; attempt++) {
            try {
                await vscode.workspace.fs.stat(uri);
                await vscode.workspace.openTextDocument(uri);
                return;
            } catch (error) {
                lastError = error;
                await this.sleep(this.fileOpenRetryDelayMs);
            }
        }

        throw lastError instanceof Error ? lastError : new Error(`Could not prepare '${uri.toString()}' for opening.`);
    }

    protected sleep(delayMs: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, delayMs));
    }

    protected rootDestination(uri: vscode.Uri): string {
        return uri.toString();
    }

    protected diagramTarget(input: string): {
        folder: string;
        path: string;
    } {
        let prefix = input;
        let name = input;

        if (input.includes('/')) {
            const lastIndex = input.lastIndexOf('/');

            name = input.slice(lastIndex + 1);
            prefix = `${input.slice(0, lastIndex)}/${name}`;
        }

        return {
            folder: prefix,
            path: `${prefix}/${name}`
        };
    }

    protected diagramDestination(input: string): string {
        return this.diagramTarget(input).path;
    }
}
