/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/

import { VSCodeContext } from '@borkdominik-biguml/big-components';
import { useContext, useEffect, useMemo, useState, type ChangeEvent, type ReactElement } from 'react';
import {
    ExportInstancesResponse,
    InstanceExplorerDataResponse,
    RequestExportInstancesAction,
    type ClassifierGroup,
    type InstanceSummary
} from '../common/index.js';

export function ExportDialog(): ReactElement {
    const { dispatchAction, listenAction } = useContext(VSCodeContext);
    const [template, setTemplate] = useState('json');
    const [scope, setScope] = useState<'all' | 'byClassifier' | 'selection'>('all');
    const [classifierId, setClassifierId] = useState<string>('');
    const [selectedInstanceIds, setSelectedInstanceIds] = useState<string[]>([]);
    const [classifierGroups, setClassifierGroups] = useState<ClassifierGroup[]>([]);
    const [unclassified, setUnclassified] = useState<InstanceSummary[]>([]);
    const [result, setResult] = useState<string>('');

    useEffect(() => {
        listenAction(action => {
            if (InstanceExplorerDataResponse.is(action)) {
                setClassifierGroups(action.classifierGroups ?? []);
                setUnclassified(action.unclassified ?? []);
                return;
            }

            if (ExportInstancesResponse.is(action)) {
                if (action.success && action.content) {
                    setResult(action.content);
                } else {
                    setResult(action.message ?? 'Export failed');
                }
            }
        });
    }, [listenAction]);

    const availableInstances = useMemo(() => flattenInstances(classifierGroups, unclassified), [classifierGroups, unclassified]);

    useEffect(() => {
        if (scope !== 'selection') {
            return;
        }

        setSelectedInstanceIds(current => {
            const allowed = new Set(availableInstances.map(instance => instance.id));
            const filtered = current.filter(id => allowed.has(id));
            if (filtered.length > 0) {
                return filtered;
            }
            return availableInstances.slice(0, 1).map(instance => instance.id);
        });
    }, [availableInstances, scope]);

    useEffect(() => {
        if (scope === 'byClassifier' && !classifierId && classifierGroups.length > 0) {
            setClassifierId(classifierGroups[0].classifierId);
        }
    }, [classifierGroups, classifierId, scope]);

    const doExport = () => {
        dispatchAction(
            RequestExportInstancesAction.create({
                action: {
                    scope,
                    classifierId: scope === 'byClassifier' ? classifierId : undefined,
                    selection: scope === 'selection' ? selectedInstanceIds : undefined,
                    templateName: template,
                    customTemplateFile: null
                }
            })
        );
    };

    const downloadResult = () => {
        const blob = new Blob([result], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'instances_export.txt';
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className='export-dialog'>
            <h3>Export Instances</h3>
            <div>
                <label>Template:</label>
                <select value={template} onChange={(event: ChangeEvent<HTMLSelectElement>) => setTemplate(event.target.value)}>
                    <option value='json'>JSON</option>
                    <option value='csv'>CSV</option>
                    <option value='xml'>XML</option>
                </select>
            </div>
            <div>
                <label>Scope:</label>
                <select value={scope} onChange={event => setScope(event.target.value as 'all' | 'byClassifier' | 'selection')}>
                    <option value='all'>All instances</option>
                    <option value='byClassifier'>By classifier</option>
                    <option value='selection'>Selection</option>
                </select>
            </div>

            {scope === 'byClassifier' && (
                <div>
                    <label>Classifier:</label>
                    <select value={classifierId} onChange={(event: ChangeEvent<HTMLSelectElement>) => setClassifierId(event.target.value)}>
                        {classifierGroups.map(group => (
                            <option key={group.classifierId} value={group.classifierId}>
                                {group.classifierName}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            {scope === 'selection' && (
                <div className='export-dialog__selection'>
                    <div>Select instances to export:</div>
                    {availableInstances.map(instance => (
                        <label key={instance.id} style={{ display: 'block' }}>
                            <input
                                checked={selectedInstanceIds.includes(instance.id)}
                                onChange={event => {
                                    setSelectedInstanceIds(current =>
                                        event.target.checked ? [...current, instance.id] : current.filter(id => id !== instance.id)
                                    );
                                }}
                                type='checkbox'
                            />{' '}
                            {instance.classifierName ? `${instance.name} : ${instance.classifierName}` : instance.name}
                        </label>
                    ))}
                </div>
            )}

            <div style={{ marginTop: 8 }}>
                <button onClick={doExport}>Export</button>
            </div>

            {result && (
                <div style={{ marginTop: 12 }}>
                    <h4>Result</h4>
                    <textarea readOnly value={result} style={{ width: '100%', height: 240 }} />
                    <div>
                        <button onClick={downloadResult}>Download</button>
                    </div>
                </div>
            )}
        </div>
    );
}

function flattenInstances(classifierGroups: ClassifierGroup[], unclassified: InstanceSummary[]): InstanceSummary[] {
    return [...classifierGroups.flatMap(group => group.instances), ...unclassified];
}
