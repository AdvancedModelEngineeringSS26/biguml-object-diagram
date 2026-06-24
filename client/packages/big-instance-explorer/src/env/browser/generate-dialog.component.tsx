/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/
import { useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import type { GenerationConfig, GenerationResultSummary, GenerationStrategyKind } from '../common/index.js';

export interface GenerateDialogClassifier {
    classifierId: string;
    classifierName: string;
}

interface GenerateDialogProps {
    classifiers: GenerateDialogClassifier[];
    preview?: GenerationResultSummary;
    onClose: () => void;
    onPreview: (config: GenerationConfig) => void;
    onGenerate: (config: GenerationConfig) => void;
}

/** Parses a `propertyName=format` block into a pattern map (one rule per line). */
function parsePatterns(text: string): Record<string, string> {
    const patterns: Record<string, string> = {};
    for (const line of text.split('\n')) {
        const separator = line.indexOf('=');
        if (separator < 0) {
            continue;
        }
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key.length > 0) {
            patterns[key] = value;
        }
    }
    return patterns;
}

/**
 * Inline, single-column generation form rendered inside the (narrow) Instances panel.
 * Deliberately not a fixed overlay so it flows with the panel and never overflows it.
 */
export function GenerateDialog(props: GenerateDialogProps): ReactElement {
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [count, setCount] = useState(3);
    const [strategy, setStrategy] = useState<GenerationStrategyKind>('random');
    const [patternsText, setPatternsText] = useState('');
    const [associationDepth, setAssociationDepth] = useState(1);
    const [seedText, setSeedText] = useState('');

    const config = useMemo<GenerationConfig>(
        () => ({
            classifierIds: selectedIds,
            countPerClassifier: count,
            strategy,
            patterns: strategy === 'pattern' ? parsePatterns(patternsText) : undefined,
            associationDepth,
            seed: seedText.trim().length > 0 ? Number(seedText) : undefined
        }),
        [selectedIds, count, strategy, patternsText, associationDepth, seedText]
    );

    const invalid = selectedIds.length === 0 || count < 1 || (seedText.trim().length > 0 && Number.isNaN(Number(seedText)));

    const toggleClassifier = (id: string) => {
        setSelectedIds(current => (current.includes(id) ? current.filter(value => value !== id) : [...current, id]));
    };

    return (
        <section style={cardStyle}>
            <div style={headerStyle}>
                <div style={titleStyle}>Generate Test Data</div>
                <button onClick={props.onClose} style={closeButtonStyle} title='Close' type='button'>
                    <span className='codicon codicon-close' />
                </button>
            </div>
            <div style={subtitleStyle}>Create instances with slot values for the selected classifiers in one undoable step.</div>

            <div style={fieldStyle}>
                <span style={labelStyle}>Classifiers</span>
                <div style={classifierPanelStyle}>
                    {props.classifiers.length > 0 ? (
                        props.classifiers.map(classifier => (
                            <label key={classifier.classifierId} style={checkboxRowStyle}>
                                <input
                                    checked={selectedIds.includes(classifier.classifierId)}
                                    onChange={() => toggleClassifier(classifier.classifierId)}
                                    type='checkbox'
                                />
                                <span>{classifier.classifierName}</span>
                            </label>
                        ))
                    ) : (
                        <div style={mutedStyle}>No instantiable classifiers (Class/DataType) in the diagram.</div>
                    )}
                </div>
            </div>

            <label style={fieldStyle}>
                <span style={labelStyle}>Instances per classifier</span>
                <input min={1} onChange={event => setCount(Math.max(1, Number(event.target.value) || 1))} type='number' value={count} />
            </label>

            <label style={fieldStyle}>
                <span style={labelStyle}>Strategy</span>
                <select value={strategy} onChange={event => setStrategy(event.target.value as GenerationStrategyKind)}>
                    <option value='random'>Random (type-driven)</option>
                    <option value='pattern'>Pattern (with random fallback)</option>
                </select>
            </label>

            {strategy === 'pattern' ? (
                <label style={fieldStyle}>
                    <span style={labelStyle}>Patterns (one propertyName=format per line)</span>
                    <textarea
                        onChange={event => setPatternsText(event.target.value)}
                        placeholder={'name=User_{n}\nemail=user{n}@example.org\nrole={pick:admin,user,guest}'}
                        rows={4}
                        style={textareaStyle}
                        value={patternsText}
                    />
                </label>
            ) : null}

            <label style={fieldStyle}>
                <span style={labelStyle}>Association depth (0 = no links)</span>
                <input
                    min={0}
                    onChange={event => setAssociationDepth(Math.max(0, Number(event.target.value) || 0))}
                    type='number'
                    value={associationDepth}
                />
            </label>

            <label style={fieldStyle}>
                <span style={labelStyle}>Seed (optional, for reproducible output)</span>
                <input onChange={event => setSeedText(event.target.value)} placeholder='e.g. 42' type='text' value={seedText} />
            </label>

            <div style={buttonRowStyle}>
                <button disabled={invalid} onClick={() => props.onPreview(config)} type='button'>
                    Preview
                </button>
                <button disabled={invalid} onClick={() => props.onGenerate(config)} type='button'>
                    Generate
                </button>
                <button onClick={props.onClose} type='button'>
                    Cancel
                </button>
            </div>

            {props.preview ? (
                <div style={previewStyle}>
                    <div style={previewTitleStyle}>Preview (dry-run, nothing applied)</div>
                    <div>
                        {props.preview.instanceCount} instance(s), {props.preview.slotCount} slot(s), {props.preview.linkCount} link(s).
                    </div>
                    {props.preview.sample.length > 0 ? (
                        <div style={sampleListStyle}>
                            {props.preview.sample.map((instance, index) => (
                                <div key={`${instance.name}-${index}`} style={sampleInstanceStyle}>
                                    <div style={sampleHeaderStyle}>
                                        {instance.name} : {instance.classifierName}
                                    </div>
                                    {instance.slots.map((slot, slotIndex) => (
                                        <div key={`${slot.feature}-${slotIndex}`} style={sampleSlotStyle}>
                                            {slot.feature} = {slot.value}
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                    ) : null}
                    {props.preview.diagnostics.length > 0 ? (
                        <ul style={diagnosticsListStyle}>
                            {props.preview.diagnostics.map((diagnostic, index) => (
                                <li key={`${diagnostic.code}-${index}`}>
                                    [{diagnostic.severity}] {diagnostic.message}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div style={mutedStyle}>No diagnostics.</div>
                    )}
                </div>
            ) : null}
        </section>
    );
}

const cardStyle: CSSProperties = {
    display: 'grid',
    gap: '10px',
    margin: '8px',
    padding: '12px',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '6px',
    background: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))'
};
const headerStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' };
const titleStyle: CSSProperties = { fontSize: '13px', fontWeight: 600 };
const subtitleStyle: CSSProperties = { opacity: 0.75, fontSize: '11px', marginTop: '-4px' };
const closeButtonStyle: CSSProperties = { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 };
const fieldStyle: CSSProperties = { display: 'grid', gap: '4px' };
const labelStyle: CSSProperties = { fontSize: '11px', opacity: 0.85 };
const mutedStyle: CSSProperties = { opacity: 0.7, fontSize: '11px' };
const classifierPanelStyle: CSSProperties = {
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '4px',
    padding: '8px',
    display: 'grid',
    gap: '4px',
    maxHeight: '140px',
    overflow: 'auto'
};
const checkboxRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' };
const textareaStyle: CSSProperties = { width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'var(--vscode-editor-font-family)' };
const buttonRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '6px' };
const previewStyle: CSSProperties = {
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '4px',
    padding: '8px',
    display: 'grid',
    gap: '6px',
    fontSize: '11px'
};
const previewTitleStyle: CSSProperties = { fontWeight: 600 };
const sampleListStyle: CSSProperties = { display: 'grid', gap: '6px', maxHeight: '220px', overflow: 'auto' };
const sampleInstanceStyle: CSSProperties = { display: 'grid', gap: '1px' };
const sampleHeaderStyle: CSSProperties = { fontWeight: 600, textDecoration: 'underline' };
const sampleSlotStyle: CSSProperties = { paddingLeft: '10px', fontFamily: 'var(--vscode-editor-font-family)' };
const diagnosticsListStyle: CSSProperties = { margin: 0, paddingLeft: '16px', display: 'grid', gap: '2px' };
