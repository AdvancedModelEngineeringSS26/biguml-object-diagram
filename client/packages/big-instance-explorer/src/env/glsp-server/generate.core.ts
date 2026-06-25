/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/
import { randomUUID } from 'node:crypto';
import { createRng } from './strategies/rng.js';
import { type PropertyDescriptor, type ValueContext, type ValueStrategy } from './strategies/strategy.js';

/**
 * The pure core of the test-data generator. It takes a plain-data view of the
 * selected classifiers (resolved from the AST elsewhere, including inherited
 * properties) and a configuration, and returns a single batch of JSON-patch
 * operations that create N instances with populated slots — plus a structured
 * summary and diagnostics.
 *
 * It is intentionally free of GLSP / Langium / IO so it can be unit-tested in
 * isolation. The GLSP handler (imperative shell) resolves the views, wraps the
 * returned patch in one `ModelPatchCommand` (atomic single-undo) and augments it
 * with layout (`Size`/`Position`) metadata, which requires live model state.
 */

/** A property of a classifier, extended with the identity needed to build cross-references. */
export interface PropertyView extends PropertyDescriptor {
    /** The property's `__id` in the model. */
    id: string;
    /** URI of the document that owns the property (for cross-document references). */
    documentUri?: string;
    /** Whether the property is required (lower multiplicity bound >= 1). */
    required?: boolean;
}

/** A classifier selected for instantiation, with its resolved (incl. inherited) properties. */
export interface ClassifierView {
    /** The classifier's `__id` in the model. */
    id: string;
    name: string;
    documentUri?: string;
    properties: readonly PropertyView[];
}

export interface GenerationConfig {
    /** Number of instances to create per classifier. */
    count: number;
    /** Strategy used to fill slot values. */
    strategy: ValueStrategy;
    /** Seed for reproducible generation (default 0). */
    seed?: number;
    /** Best-effort retry count for `isUnique` properties (default 8). */
    uniquenessRetries?: number;
    /** Names already used in the model, to avoid collisions. */
    reservedNames?: Iterable<string>;
    /** Id generator; injectable for deterministic tests (default random UUID). */
    idFactory?: () => string;
}

export interface PatchOperation {
    op: 'add';
    path: string;
    value: unknown;
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export type GenerationDiagnosticCode =
    | 'REQUIRED_PROPERTY_SKIPPED'
    | 'UNIQUENESS_BEST_EFFORT'
    | 'TYPE_MISMATCH'
    | 'MULTIPLICITY_BEST_EFFORT';

export interface GenerationDiagnostic {
    code: GenerationDiagnosticCode;
    message: string;
    severity: DiagnosticSeverity;
    classifierName?: string;
    propertyName?: string;
}

export interface GeneratedInstanceSummary {
    id: string;
    name: string;
    classifierId: string;
    classifierName: string;
    slotCount: number;
}

export interface GenerationResult {
    /** Semantic add operations (instances with inline slots). Atomic batch. */
    patch: PatchOperation[];
    instances: GeneratedInstanceSummary[];
    diagnostics: GenerationDiagnostic[];
}

/** One generated slot in a preview sample. */
export interface PreviewSlotSample {
    feature: string;
    value: string;
}

/** One generated instance in a preview sample (dry-run view of what will be created). */
export interface PreviewInstanceSample {
    name: string;
    classifierName: string;
    slots: PreviewSlotSample[];
}

/**
 * Builds a human-readable sample (up to `limit` instances) from a generation patch,
 * for the dry-run preview. Reads the instance add operations produced by
 * {@link buildGeneration} without touching the model.
 */
export function extractPreviewSample(patch: readonly PatchOperation[], limit: number): PreviewInstanceSample[] {
    const samples: PreviewInstanceSample[] = [];
    for (const operation of patch) {
        if (samples.length >= limit) {
            break;
        }
        if (operation.path !== '/diagram/entities/-') {
            continue;
        }
        const instance = operation.value as {
            name?: string;
            classifier?: { $refText?: string };
            slots?: { name?: string; values?: { value?: string }[] }[];
        };
        samples.push({
            name: instance.name ?? '',
            classifierName: instance.classifier?.$refText ?? '',
            slots: (instance.slots ?? []).map(slot => ({
                feature: slot.name ?? '',
                value: slot.values?.[0]?.value ?? ''
            }))
        });
    }
    return samples;
}

const DEFAULT_UNIQUENESS_RETRIES = 8;

/** Whether a generated string value is compatible with the property's declared type. */
function isValueCompatible(property: PropertyView, value: string): boolean {
    switch (property.typeKind) {
        case 'integer':
            return Number.isInteger(Number(value));
        case 'real':
            return value.trim() !== '' && !Number.isNaN(Number(value));
        case 'boolean':
            return value === 'true' || value === 'false';
        case 'enumeration':
            // Only judge when the literals are known.
            return !property.enumLiterals || property.enumLiterals.includes(value);
        case 'string':
        case 'reference':
        case 'unknown':
        default:
            return true;
    }
}

/**
 * Makes a generated value safe to store in a `LiteralSpecification`. The bigUML
 * grammar parses slot values as a `LANGIUM_ID` token (`/[^\s"{}\[\]:,\\]+/`), so
 * realistic punctuation (dots, `@`, apostrophes, parentheses, dashes) is kept as-is,
 * and only the disallowed characters — whitespace, JSON-structural `{ } [ ] : , "`,
 * and `\` — are replaced with `_`. E.g. "alice.smith@example.com" and "O'Brien" are
 * preserved, while "Monica Gutmann" -> "Monica_Gutmann" and
 * "Hirthe, Hirthe and Hirthe" -> "Hirthe_Hirthe_and_Hirthe". Protects every strategy
 * (random/pattern/realistic) and user-typed patterns alike.
 *
 * (Full whitespace/comma support would require an escaped-string grammar terminal —
 * see planning/feature-4-implementation-report.md.)
 */
export function sanitizeSlotValue(value: string): string {
    const safe = value.replace(/[\s"{}[\]:,\\]+/g, '_').replace(/^_+|_+$/g, '');
    return safe.length > 0 ? safe : 'value';
}

function buildSlot(property: PropertyView, value: string, idFactory: () => string): Record<string, unknown> {
    return {
        $type: 'Slot',
        __id: idFactory(),
        name: property.name,
        definingFeature: {
            ref: { __id: property.id, __documentUri: property.documentUri },
            $refText: property.name
        },
        values: [
            {
                $type: 'LiteralSpecification',
                __id: idFactory(),
                name: 'value1',
                value: sanitizeSlotValue(value)
            }
        ]
    };
}

function buildInstance(
    id: string,
    name: string,
    classifier: ClassifierView,
    slots: Record<string, unknown>[]
): Record<string, unknown> {
    return {
        $type: 'InstanceSpecification',
        __id: id,
        name,
        classifier: {
            ref: { __id: classifier.id, __documentUri: classifier.documentUri },
            $refText: classifier.name
        },
        slots
    };
}

function nextName(classifierName: string, usedNames: Set<string>): string {
    const base = classifierName.toLowerCase();
    let k = 1;
    let candidate = `${base}_${k}`;
    while (usedNames.has(candidate)) {
        k++;
        candidate = `${base}_${k}`;
    }
    return candidate;
}

/**
 * Builds the atomic generation patch for the given classifier views.
 *
 * Constraint handling (topic feature 4e):
 * - `isReadOnly` properties are skipped (no slot).
 * - required properties that cannot be generated produce a diagnostic.
 * - `isUnique` properties are de-duplicated best-effort (with a diagnostic on failure).
 * - values incompatible with the property type produce a diagnostic.
 */
export function buildGeneration(classifiers: readonly ClassifierView[], config: GenerationConfig): GenerationResult {
    const rng = createRng(config.seed ?? 0);
    const idFactory = config.idFactory ?? randomUUID;
    const retries = config.uniquenessRetries ?? DEFAULT_UNIQUENESS_RETRIES;
    const usedNames = new Set<string>(config.reservedNames ?? []);

    const patch: PatchOperation[] = [];
    const instances: GeneratedInstanceSummary[] = [];
    const diagnostics: GenerationDiagnostic[] = [];

    for (const classifier of classifiers) {
        const seenValuesByProperty = new Map<string, Set<string>>();

        for (let index = 1; index <= config.count; index++) {
            const instanceId = idFactory();
            const name = nextName(classifier.name, usedNames);
            usedNames.add(name);

            const slots: Record<string, unknown>[] = [];

            for (const property of classifier.properties) {
                if (property.isReadOnly) {
                    continue;
                }

                const ctx: ValueContext = { rng, index, classifierId: classifier.id };
                let value = config.strategy.value(property, ctx);

                if (value !== undefined && property.isUnique) {
                    const seen = seenValuesByProperty.get(property.name) ?? new Set<string>();
                    let attempts = 0;
                    while (value !== undefined && seen.has(value) && attempts < retries) {
                        value = config.strategy.value(property, ctx);
                        attempts++;
                    }
                    if (value !== undefined && seen.has(value)) {
                        diagnostics.push({
                            code: 'UNIQUENESS_BEST_EFFORT',
                            severity: 'warning',
                            classifierName: classifier.name,
                            propertyName: property.name,
                            message: `Could not generate a unique value for ${classifier.name}.${property.name}; a duplicate was kept.`
                        });
                    }
                    if (value !== undefined) {
                        seen.add(value);
                    }
                    seenValuesByProperty.set(property.name, seen);
                }

                if (value === undefined) {
                    if (property.required) {
                        diagnostics.push({
                            code: 'REQUIRED_PROPERTY_SKIPPED',
                            severity: 'warning',
                            classifierName: classifier.name,
                            propertyName: property.name,
                            message: `Required property ${classifier.name}.${property.name} could not be generated and was left empty.`
                        });
                    }
                    continue;
                }

                if (!isValueCompatible(property, value)) {
                    diagnostics.push({
                        code: 'TYPE_MISMATCH',
                        severity: 'warning',
                        classifierName: classifier.name,
                        propertyName: property.name,
                        message: `Generated value "${value}" is not compatible with type ${property.typeName ?? property.typeKind} of ${classifier.name}.${property.name}.`
                    });
                }

                slots.push(buildSlot(property, value, idFactory));
            }

            patch.push({
                op: 'add',
                path: '/diagram/entities/-',
                value: buildInstance(instanceId, name, classifier, slots)
            });
            instances.push({
                id: instanceId,
                name,
                classifierId: classifier.id,
                classifierName: classifier.name,
                slotCount: slots.length
            });
        }
    }

    return { patch, instances, diagnostics };
}
