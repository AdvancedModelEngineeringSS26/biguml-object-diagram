/*********************************************************************************
 * Copyright (c) 2023 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 *********************************************************************************/
import { ClientState, Deferred, SocketGlspVscodeServer, type InitializeParameters } from '@eclipse-glsp/vscode-integration';
import { inject, injectable } from 'inversify';
import { TYPES } from '../../../vscode/vscode-common.types.js';
import type { GlspServerConfig } from './glsp-server.module.js';

@injectable()
export class GlspServer extends SocketGlspVscodeServer {
    protected startPromise?: Promise<void>;
    protected readonly startRetryCount = 20;
    protected readonly startRetryDelayMs = 250;

    constructor(@inject(TYPES.GlspServerConfig) protected readonly glspServerConfig: GlspServerConfig) {
        super({
            clientId: 'glsp.uml',
            clientName: 'uml',
            connectionOptions: {
                port: glspServerConfig.port
            }
        });
    }

    override async start(): Promise<void> {
        if (!this.startPromise) {
            this.startPromise = this.startWithRetry().catch(error => {
                this.startPromise = undefined;
                throw error;
            });
        }

        return this.startPromise;
    }

    protected async startWithRetry(): Promise<void> {
        let lastError: unknown;

        for (let attempt = 0; attempt < this.startRetryCount; attempt++) {
            this.readyDeferred = new Deferred<void>();
            try {
                await this.startOnce();
                return;
            } catch (error) {
                lastError = error;
                this.readyDeferred.reject(error);
                await this.disposeClient();
                if (!this.isRetryableConnectionError(error) || attempt === this.startRetryCount - 1) {
                    throw error;
                }
                await this.sleep(this.startRetryDelayMs);
            }
        }

        throw lastError instanceof Error ? lastError : new Error('Failed to start the GLSP server.');
    }

    protected async startOnce(): Promise<void> {
        this._glspClient = await this.createGLSPClient();
        await this._glspClient.start();

        if (this._glspClient.currentState !== ClientState.Running) {
            throw this.createRetryableStartError(`GLSP client did not reach running state. Current state: ${this._glspClient.currentState}`);
        }

        this._initializeResult = await this._glspClient.initializeServer(await this.createInitializeParameters());
        this._glspClient.onActionMessage(message => {
            this.onServerSendEmitter.fire(message);
        });
        this.readyDeferred.resolve();
    }

    protected isRetryableConnectionError(error: unknown): boolean {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        const message = error instanceof Error ? error.message : '';
        return code === 'ECONNREFUSED' || /ECONNREFUSED|not ready|running state/i.test(message);
    }

    protected sleep(delayMs: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, delayMs));
    }

    protected async disposeClient(): Promise<void> {
        try {
            await this._glspClient?.stop();
        } catch {
            // No-op. Failed startup attempts can leave the socket client half-initialized.
        }
    }

    protected createRetryableStartError(message: string): NodeJS.ErrnoException {
        const error = new Error(message) as NodeJS.ErrnoException;
        error.code = 'ECONNREFUSED';
        return error;
    }

    protected override async createInitializeParameters(): Promise<InitializeParameters> {
        return {
            ...(await super.createInitializeParameters()),
            args: {
                timestamp: new Date().toString()
            }
        };
    }
}
