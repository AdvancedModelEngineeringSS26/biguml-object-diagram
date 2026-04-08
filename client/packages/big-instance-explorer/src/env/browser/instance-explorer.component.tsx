/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/

import { VSCodeContext } from '@borkdominik-biguml/big-components';
import { CenterAction, SelectAction, SelectAllAction } from '@eclipse-glsp/protocol';
import { useContext, useEffect, useState, type ChangeEvent, type KeyboardEvent, type ReactElement } from 'react';
import {
    CreateClassifierInstanceOperation,
    InstanceExplorerDataResponse,
    UpdateInstanceSlotValuesOperation,
    type ClassifierGroup,
    type ClassifierType,
    type DiagnosticSummary,
    type InstanceSummary,
    type SlotSummary
} from '../common/index.js';

interface EditState {
    slotId: string;
    value: string;
}

export function InstanceExplorer(): ReactElement {
    const { clientId, dispatchAction, listenAction } = useContext(VSCodeContext);
    const [classifierGroups, setClassifierGroups] = useState<ClassifierGroup[]>([]);
    const [unclassified, setUnclassified] = useState<InstanceSummary[]>([]);
    const [searchText, setSearchText] = useState('');
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
    const [expandedInstances, setExpandedInstances] = useState<Record<string, boolean>>({});
    const [editState, setEditState] = useState<EditState | undefined>();

    useEffect(() => {
        listenAction(action => {
            if (!InstanceExplorerDataResponse.is(action)) {
                return;
            }

            setClassifierGroups(action.classifierGroups);
            setUnclassified(action.unclassified);
        });
    }, [listenAction]);

    useEffect(() => {
        setExpandedGroups(current => {
            const next = { ...current };
            for (const group of classifierGroups) {
                if (next[group.classifierId] === undefined) {
                    next[group.classifierId] = true;
                }
            }
            if (unclassified.length > 0 && next.unclassified === undefined) {
                next.unclassified = true;
            }
            return next;
        });

        setExpandedInstances(current => {
            const next = { ...current };
            for (const instance of flattenInstances(classifierGroups, unclassified)) {
                if (next[instance.id] === undefined) {
                    next[instance.id] = false;
                }
            }
            return next;
        });
    }, [classifierGroups, unclassified]);

    const query = searchText.trim().toLowerCase();
    const filteredGroups = filterGroups(classifierGroups, query);
    const filteredUnclassified = filterInstances(unclassified, query);
    const totalInstances = classifierGroups.reduce((sum, group) => sum + group.instances.length, 0) + unclassified.length;

    const navigateTo = (elementId: string | undefined) => {
        if (!clientId || !elementId) {
            return;
        }

        dispatchAction(SelectAllAction.create(false));
        dispatchAction(SelectAction.create({ selectedElementsIDs: [elementId] }));
        dispatchAction(CenterAction.create([elementId]));
    };

    const createInstance = (classifierId: string) => {
        if (!clientId) {
            return;
        }

        dispatchAction(CreateClassifierInstanceOperation.create({ classifierId }));
    };

    const commitEdit = (current: EditState | undefined) => {
        if (!current) {
            return;
        }

        if (clientId) {
            dispatchAction(
                UpdateInstanceSlotValuesOperation.create({
                    slotId: current.slotId,
                    values: parseValues(current.value)
                })
            );
        }

        setEditState(undefined);
    };

    const renderDiagnostics = (diagnostics: DiagnosticSummary[]) => {
        if (diagnostics.length === 0) {
            return null;
        }

        return (
            <span className='instance-explorer__warning' title={diagnostics.map(diagnostic => diagnostic.message).join('\n')}>
                <span className='codicon codicon-warning' />
                <span>{diagnostics.length}</span>
            </span>
        );
    };

    const renderSlot = (slot: SlotSummary) => {
        const isEditing = editState?.slotId === slot.id;

        return (
            <div
                key={slot.id}
                className='instance-explorer__slot'
                onDoubleClick={() => setEditState({ slotId: slot.id, value: formatValues(slot.values) })}
            >
                <span className='instance-explorer__slot-feature'>{slot.featureName || '(unnamed slot)'}</span>
                <span className='instance-explorer__slot-equals'>=</span>
                {isEditing ? (
                    <input
                        autoFocus
                        className='instance-explorer__input instance-explorer__slot-input'
                        value={editState?.value ?? ''}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            setEditState(current => (current ? { ...current, value: event.target.value } : current))
                        }
                        onBlur={() => commitEdit(editState)}
                        onClick={event => event.stopPropagation()}
                        onDoubleClick={event => event.stopPropagation()}
                        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                            if (event.key === 'Enter') {
                                commitEdit(editState);
                            } else if (event.key === 'Escape') {
                                setEditState(undefined);
                            }
                        }}
                    />
                ) : (
                    <span className='instance-explorer__slot-value'>{formatValues(slot.values)}</span>
                )}
                {renderDiagnostics(slot.diagnostics)}
            </div>
        );
    };

    const renderInstance = (instance: InstanceSummary) => {
        const expanded = expandedInstances[instance.id];
        const label = instance.classifierName ? `${instance.name} : ${instance.classifierName}` : instance.name;

        return (
            <div key={instance.id} className='instance-explorer__instance'>
                <button
                    className='instance-explorer__row instance-explorer__row--instance'
                    onClick={() => navigateTo(instance.id)}
                    type='button'
                >
                    <span
                        className={`codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'} instance-explorer__disclosure`}
                        onClick={event => {
                            event.preventDefault();
                            event.stopPropagation();
                            setExpandedInstances(current => ({ ...current, [instance.id]: !current[instance.id] }));
                        }}
                    />
                    <span className='codicon codicon-symbol-field instance-explorer__icon' />
                    <span className='instance-explorer__label'>{label}</span>
                    {renderDiagnostics(instance.diagnostics)}
                </button>
                {expanded && instance.slots.length > 0 ? <div className='instance-explorer__slots'>{instance.slots.map(renderSlot)}</div> : null}
            </div>
        );
    };

    const renderGroup = (group: ClassifierGroup) => {
        const expanded = expandedGroups[group.classifierId];

        return (
            <section key={group.classifierId} className='instance-explorer__group'>
                <div className='instance-explorer__row instance-explorer__row--group'>
                    <button
                        className='instance-explorer__row-main'
                        onClick={() => setExpandedGroups(current => ({ ...current, [group.classifierId]: !current[group.classifierId] }))}
                        type='button'
                    >
                        <span className={`codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'} instance-explorer__disclosure`} />
                        <span className={`codicon ${classifierIcon(group.classifierType)} instance-explorer__icon`} />
                        <span
                            className='instance-explorer__label'
                            onClick={event => {
                                event.preventDefault();
                                event.stopPropagation();
                                navigateTo(group.classifierId);
                            }}
                        >
                            {group.classifierName}
                        </span>
                    </button>
                    <span className='instance-explorer__count'>{group.instances.length}</span>
                    <button
                        className='instance-explorer__icon-button'
                        onClick={() => createInstance(group.classifierId)}
                        title={`Create instance of ${group.classifierName}`}
                        type='button'
                    >
                        <span className='codicon codicon-add' />
                    </button>
                </div>
                {expanded ? <div className='instance-explorer__children'>{group.instances.map(renderInstance)}</div> : null}
            </section>
        );
    };

    const showEmptyState = filteredGroups.length === 0 && filteredUnclassified.length === 0;

    return (
        <div className='instance-explorer'>
            <header className='instance-explorer__header'>
                <div className='instance-explorer__title'>Model Instance Explorer</div>
                <div className='instance-explorer__subtitle'>{totalInstances} instance(s) in the current diagram</div>
                <input
                    className='instance-explorer__input'
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setSearchText(event.target.value)}
                    placeholder='Filter by classifier, instance, slot, or value'
                    type='search'
                    value={searchText}
                />
            </header>

            <div className='instance-explorer__tree'>
                {filteredGroups.map(renderGroup)}

                {filteredUnclassified.length > 0 ? (
                    <section className='instance-explorer__group'>
                        <div className='instance-explorer__row instance-explorer__row--group'>
                            <button
                                className='instance-explorer__row-main'
                                onClick={() => setExpandedGroups(current => ({ ...current, unclassified: !current.unclassified }))}
                                type='button'
                            >
                                <span
                                    className={`codicon ${
                                        expandedGroups.unclassified ? 'codicon-chevron-down' : 'codicon-chevron-right'
                                    } instance-explorer__disclosure`}
                                />
                                <span className='codicon codicon-question instance-explorer__icon' />
                                <span className='instance-explorer__label'>Unclassified</span>
                            </button>
                            <span className='instance-explorer__count'>{filteredUnclassified.length}</span>
                        </div>
                        {expandedGroups.unclassified ? (
                            <div className='instance-explorer__children'>{filteredUnclassified.map(renderInstance)}</div>
                        ) : null}
                    </section>
                ) : null}

                {showEmptyState ? (
                    <div className='instance-explorer__empty'>No matching instances were found in the active diagram.</div>
                ) : null}
            </div>
        </div>
    );
}

function flattenInstances(classifierGroups: ClassifierGroup[], unclassified: InstanceSummary[]): InstanceSummary[] {
    return [...classifierGroups.flatMap(group => group.instances), ...unclassified];
}

function filterGroups(groups: ClassifierGroup[], query: string): ClassifierGroup[] {
    if (!query) {
        return groups;
    }

    const filtered: ClassifierGroup[] = [];
    for (const group of groups) {
        if (group.classifierName.toLowerCase().includes(query)) {
            filtered.push(group);
            continue;
        }

        const instances = filterInstances(group.instances, query);
        if (instances.length > 0) {
            filtered.push({
                ...group,
                instances
            });
        }
    }

    return filtered;
}

function filterInstances(instances: InstanceSummary[], query: string): InstanceSummary[] {
    if (!query) {
        return instances;
    }

    return instances.filter(instance => {
        if (instance.name.toLowerCase().includes(query)) {
            return true;
        }

        if (instance.classifierName?.toLowerCase().includes(query)) {
            return true;
        }

        if (instance.diagnostics.some(diagnostic => diagnostic.message.toLowerCase().includes(query))) {
            return true;
        }

        return instance.slots.some(slot => {
            if (slot.featureName.toLowerCase().includes(query)) {
                return true;
            }

            if (slot.values.some(value => value.toLowerCase().includes(query))) {
                return true;
            }

            return slot.diagnostics.some(diagnostic => diagnostic.message.toLowerCase().includes(query));
        });
    });
}

function parseValues(value: string): string[] {
    return value
        .split(/\r?\n|,/)
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);
}

function formatValues(values: string[]): string {
    return values.length > 0 ? values.join(', ') : '';
}

function classifierIcon(classifierType: ClassifierType): string {
    switch (classifierType) {
        case 'Interface':
            return 'codicon-symbol-interface';
        case 'DataType':
            return 'codicon-symbol-key';
        default:
            return 'codicon-symbol-class';
    }
}
