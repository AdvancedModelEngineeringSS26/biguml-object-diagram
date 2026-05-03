/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/

import { bindWebviewViewFactory, VscodeFeatureModule } from '@borkdominik-biguml/big-vscode/vscode';
import { InstanceExplorerWebviewViewProvider } from './instance-explorer.webview-view-provider.js';

export function instanceExplorerModule(viewType: string) {
    return new VscodeFeatureModule(context => {
        bindWebviewViewFactory(context, {
            provider: InstanceExplorerWebviewViewProvider,
            options: {
                viewType
            }
        });
    });
}
