/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/

import { VSCodeContext } from '@borkdominik-biguml/big-components';
import { UpdateOperation } from '@borkdominik-biguml/uml-glsp-server';
import { CenterAction, SelectAction, SelectAllAction } from '@eclipse-glsp/protocol';
import { useContext, useEffect, useState, type ChangeEvent, type KeyboardEvent, type ReactElement } from 'react';
import {
    CreateClassifierInstanceOperation,
    InstanceExplorerDataResponse,
    UpdateInstanceLinkEndOperation,
    UpdateInstanceSlotValuesOperation,
    type ClassifierGroup,
    type ClassifierType,
    type DiagnosticSummary,
    type EligibleInstance,
    type InstanceLinkSummary,
    type InstanceSummary,
    type ManyToManyRelationSection,
    type SlotSummary
} from '../common/index.js';

type EditTarget = 'slot' | 'instance' | 'classifier';

interface EditState {
    kind: EditTarget;
    targetId: string;
    value: string;
}

interface LinkEditState {
    linkId: string;
    end: 'source' | 'target';
}

export function InstanceExplorer(): ReactElement {
    const { clientId, dispatchAction, listenAction } = useContext(VSCodeContext);
    const [classifierGroups, setClassifierGroups] = useState<ClassifierGroup[]>([]);
    const [unclassified, setUnclassified] = useState<InstanceSummary[]>([]);
    const [manyToManyRelations, setManyToManyRelations] = useState<ManyToManyRelationSection[]>([]);
    const [searchText, setSearchText] = useState('');
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
    const [expandedInstances, setExpandedInstances] = useState<Record<string, boolean>>({});
    const [editState, setEditState] = useState<EditState | undefined>();
    const [linkEditState, setLinkEditState] = useState<LinkEditState | undefined>();

    useEffect(() => {
        listenAction(action => {
            if (!InstanceExplorerDataResponse.is(action)) {
                return;
            }

            setClassifierGroups(action.classifierGroups);
            setUnclassified(action.unclassified);
            setManyToManyRelations(action.manyToManyRelations ?? []);
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
            for (const section of manyToManyRelations) {
                if (next[section.id] === undefined) {
                    next[section.id] = true;
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
    }, [classifierGroups, unclassified, manyToManyRelations]);

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

    const commitLinkEdit = (linkId: string, end: 'source' | 'target', newInstanceId: string) => {
        if (clientId && newInstanceId) {
            dispatchAction(UpdateInstanceLinkEndOperation.create({ linkId, end, newInstanceId }));
        }
        setLinkEditState(undefined);
    };

    const renderLinkPicker = (linkId: string, end: 'source' | 'target', eligible: EligibleInstance[], currentId: string) => {
        const options = eligible.some(candidate => candidate.id === currentId)
            ? eligible
            : [{ id: currentId, name: currentId, classifierName: undefined } as EligibleInstance, ...eligible];

        return (
            <select
                autoFocus
                className='instance-explorer__input instance-explorer__slot-input'
                defaultValue={currentId}
                onBlur={() => setLinkEditState(undefined)}
                onChange={event => {
                    const nextId = event.target.value;
                    if (nextId && nextId !== currentId) {
                        commitLinkEdit(linkId, end, nextId);
                    } else {
                        setLinkEditState(undefined);
                    }
                }}
                onClick={event => event.stopPropagation()}
                onDoubleClick={event => event.stopPropagation()}
                onKeyDown={(event: KeyboardEvent<HTMLSelectElement>) => {
                    if (event.key === 'Escape') {
                        setLinkEditState(undefined);
                    }
                }}
            >
                {options.map(candidate => (
                    <option key={candidate.id} value={candidate.id}>
                        {candidate.classifierName ? `${candidate.name} : ${candidate.classifierName}` : candidate.name}
                    </option>
                ))}
            </select>
        );
    };

    const commitEdit = (current: EditState | undefined) => {
        if (!current) {
            return;
        }

        if (clientId) {
            if (current.kind === 'slot') {
            dispatchAction(
                UpdateInstanceSlotValuesOperation.create({
                        slotId: current.targetId,
                    values: parseValues(current.value)
                })
            );
            } else {
                const trimmed = current.value.trim();
                if (trimmed.length > 0) {
                    dispatchAction(UpdateOperation.create(current.targetId, 'name', trimmed));
        }
            }
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
        const isEditing = editState?.kind === 'slot' && editState.targetId === slot.id;

        return (
            <div
                key={slot.id}
                className='instance-explorer__slot'
                onDoubleClick={() => setEditState({ kind: 'slot', targetId: slot.id, value: formatValues(slot.values) })}
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
        const isRenaming = editState?.kind === 'instance' && editState.targetId === instance.id;

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
                    <span className='instance-explorer__label'>
                        {isRenaming ? (
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
                            <span
                                onDoubleClick={event => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setEditState({ kind: 'instance', targetId: instance.id, value: instance.name });
                                }}
                            >
                                {instance.name}
                            </span>
                        )}
                        {instance.classifierName ? <span>{` : ${instance.classifierName}`}</span> : null}
                    </span>
                    {renderDiagnostics(instance.diagnostics)}
                </button>
                {expanded && (instance.slots.length > 0 || instance.links.length > 0) ? (
                    <div className='instance-explorer__slots'>
                        {instance.slots.map(renderSlot)}
                        {instance.links.map(renderLink)}
                    </div>
                ) : null}
            </div>
        );
    };

    const renderLink = (link: InstanceLinkSummary) => {
        const arrow = link.direction === 'outgoing' ? '→' : '←';
        const peerLabel = link.peerClassifierName ? `${link.peerInstanceName} : ${link.peerClassifierName}` : link.peerInstanceName;
        const isEditingPeer = linkEditState?.linkId === link.id && linkEditState.end === link.peerEnd;
        return (
            <div key={link.id} className='instance-explorer__slot instance-explorer__link'>
                <span className='instance-explorer__slot-feature'>{link.relationName}</span>
                <span className='instance-explorer__slot-equals'>{arrow}</span>
                {isEditingPeer ? (
                    renderLinkPicker(link.id, link.peerEnd, link.eligiblePeers, link.peerInstanceId)
                ) : (
                    <button
                        className='instance-explorer__link-peer'
                        onClick={event => {
                            event.preventDefault();
                            event.stopPropagation();
                            navigateTo(link.peerInstanceId);
                        }}
                        onDoubleClick={event => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (link.eligiblePeers.length > 0) {
                                setLinkEditState({ linkId: link.id, end: link.peerEnd });
                            }
                        }}
                        title='Double-click to change to another eligible instance'
                        type='button'
                    >
                        {peerLabel}
                    </button>
                )}
                <span />
            </div>
        );
    };

    const renderGroup = (group: ClassifierGroup) => {
        const expanded = expandedGroups[group.classifierId];
        const isRenaming = editState?.kind === 'classifier' && editState.targetId === group.classifierId;

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
                        {isRenaming ? (
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
                        <span
                            className='instance-explorer__label'
                            onClick={event => {
                                event.preventDefault();
                                event.stopPropagation();
                                navigateTo(group.classifierId);
                            }}
                                onDoubleClick={event => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setEditState({ kind: 'classifier', targetId: group.classifierId, value: group.classifierName });
                                }}
                        >
                            {group.classifierName}
                        </span>
                        )}
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

    const renderManyToManyRelation = (section: ManyToManyRelationSection) => {
        const expanded = expandedGroups[section.id];
        return (
            <section key={section.id} className='instance-explorer__group'>
                <div className='instance-explorer__row instance-explorer__row--group'>
                    <button
                        className='instance-explorer__row-main'
                        onClick={() => setExpandedGroups(current => ({ ...current, [section.id]: !current[section.id] }))}
                        type='button'
                    >
                        <span className={`codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'} instance-explorer__disclosure`} />
                        <span className='codicon codicon-references instance-explorer__icon' />
                        <span className='instance-explorer__label'>{`${section.name} : ${section.relationType}`}</span>
                    </button>
                    <span className='instance-explorer__count'>{section.links.length}</span>
                </div>
                {expanded ? (
                    <div className='instance-explorer__children'>
                        {section.links.map(link => {
                            const isEditingSource = linkEditState?.linkId === link.id && linkEditState.end === 'source';
                            const isEditingTarget = linkEditState?.linkId === link.id && linkEditState.end === 'target';
                            return (
                                <div key={link.id} className='instance-explorer__row instance-explorer__row--m2m'>
                                    <span className='codicon codicon-symbol-field instance-explorer__icon' />
                                    {isEditingSource ? (
                                        renderLinkPicker(link.id, 'source', link.eligibleSources, link.sourceInstanceId)
                                    ) : (
                                        <button
                                            className='instance-explorer__link-peer'
                                            onClick={event => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                navigateTo(link.sourceInstanceId);
                                            }}
                                            onDoubleClick={event => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                if (link.eligibleSources.length > 0) {
                                                    setLinkEditState({ linkId: link.id, end: 'source' });
                                                }
                                            }}
                                            title='Double-click to change to another eligible instance'
                                            type='button'
                                        >
                                            {link.sourceClassifierName
                                                ? `${link.sourceInstanceName} : ${link.sourceClassifierName}`
                                                : link.sourceInstanceName}
                                        </button>
                                    )}
                                    <span className='instance-explorer__slot-equals'>→</span>
                                    {isEditingTarget ? (
                                        renderLinkPicker(link.id, 'target', link.eligibleTargets, link.targetInstanceId)
                                    ) : (
                                        <button
                                            className='instance-explorer__link-peer'
                                            onClick={event => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                navigateTo(link.targetInstanceId);
                                            }}
                                            onDoubleClick={event => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                if (link.eligibleTargets.length > 0) {
                                                    setLinkEditState({ linkId: link.id, end: 'target' });
                                                }
                                            }}
                                            title='Double-click to change to another eligible instance'
                                            type='button'
                                        >
                                            {link.targetClassifierName
                                                ? `${link.targetInstanceName} : ${link.targetClassifierName}`
                                                : link.targetInstanceName}
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : null}
            </section>
        );
    };

    const filteredManyToMany = filterManyToMany(manyToManyRelations, query);
    const showEmptyState = filteredGroups.length === 0 && filteredUnclassified.length === 0 && filteredManyToMany.length === 0;

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

                {filteredManyToMany.map(renderManyToManyRelation)}

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

        if (
            instance.links.some(
                link =>
                    link.relationName.toLowerCase().includes(query) ||
                    link.peerInstanceName.toLowerCase().includes(query) ||
                    (link.peerClassifierName?.toLowerCase().includes(query) ?? false)
            )
        ) {
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

function filterManyToMany(sections: ManyToManyRelationSection[], query: string): ManyToManyRelationSection[] {
    if (!query) {
        return sections;
    }

    const filtered: ManyToManyRelationSection[] = [];
    for (const section of sections) {
        if (section.name.toLowerCase().includes(query) || section.relationType.toLowerCase().includes(query)) {
            filtered.push(section);
            continue;
        }
        const links = section.links.filter(
            link =>
                link.sourceInstanceName.toLowerCase().includes(query) ||
                link.targetInstanceName.toLowerCase().includes(query) ||
                (link.sourceClassifierName?.toLowerCase().includes(query) ?? false) ||
                (link.targetClassifierName?.toLowerCase().includes(query) ?? false)
        );
        if (links.length > 0) {
            filtered.push({ ...section, links });
        }
    }
    return filtered;
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
