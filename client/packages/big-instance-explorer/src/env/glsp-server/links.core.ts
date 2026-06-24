/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/
import { randomUUID } from 'node:crypto';
import { type GenerationDiagnostic, type PatchOperation } from './generate.core.js';
import { createRng, type Rng } from './strategies/rng.js';

/**
 * Pure planner for instance links (topic feature 4a/4e). Given the generated
 * instances and a plain-data view of the associations between their classifiers,
 * it produces `InstanceLink` add operations that respect target-end
 * multiplicity, best-effort. Like the generation core it is free of GLSP/IO and
 * fully unit-testable; the GLSP handler (slice 5) appends these ops to the same
 * atomic `ModelPatchCommand`.
 */

/** Minimal view of a generated instance needed to wire links. */
export interface LinkableInstance {
    id: string;
    name: string;
    classifierId: string;
    documentUri?: string;
}

/** Plain-data view of an association between two classifiers. */
export interface AssociationView {
    id: string;
    name?: string;
    documentUri?: string;
    sourceClassifierId: string;
    targetClassifierId: string;
    /** Lower multiplicity at the target end (links per source). Default 0. */
    targetLowerBound?: number;
    /** Upper multiplicity at the target end; `undefined` means unbounded (`*`). */
    targetUpperBound?: number;
}

export interface LinkPlanOptions {
    /** How deeply to follow associations. 0 = no links; >= 1 = direct associations among generated instances. */
    depth: number;
    /** Seed for reproducible link selection (default 0). */
    seed?: number;
    /**
     * Minimum links to create per source, regardless of the association's lower bound
     * (capped by the upper bound and the number of available targets). Lets "generate
     * links" (depth >= 1) produce visible links even for optional (`0..*`) associations.
     * Default 0 (strict multiplicity).
     */
    minPerSource?: number;
    /**
     * If provided, only instances whose id is in this set originate links (targets may be
     * any instance in the pool). Used to wire links *from* newly generated instances to
     * existing or generated targets, without adding links to pre-existing instances.
     * When omitted, every instance can act as a source.
     */
    sourceIds?: ReadonlySet<string>;
    /** Id generator; injectable for deterministic tests (default random UUID). */
    idFactory?: () => string;
}

export interface GeneratedLinkSummary {
    id: string;
    name: string;
    associationId: string;
    sourceInstanceId: string;
    targetInstanceId: string;
}

export interface LinkPlanResult {
    patch: PatchOperation[];
    links: GeneratedLinkSummary[];
    diagnostics: GenerationDiagnostic[];
}

function groupByClassifier(instances: readonly LinkableInstance[]): Map<string, LinkableInstance[]> {
    const map = new Map<string, LinkableInstance[]>();
    for (const instance of instances) {
        const list = map.get(instance.classifierId) ?? [];
        list.push(instance);
        map.set(instance.classifierId, list);
    }
    return map;
}

/** Picks up to `count` distinct elements from `items` using the seeded RNG. */
function pickDistinct<T>(rng: Rng, items: readonly T[], count: number): T[] {
    const pool = [...items];
    const result: T[] = [];
    const n = Math.min(count, pool.length);
    for (let i = 0; i < n; i++) {
        const index = rng.int(0, pool.length - 1);
        result.push(pool[index]);
        pool.splice(index, 1);
    }
    return result;
}

function buildLink(
    association: AssociationView,
    source: LinkableInstance,
    target: LinkableInstance,
    id: string
): Record<string, unknown> {
    return {
        $type: 'InstanceLink',
        __id: id,
        name: association.name || `${source.name}-${target.name}-link`,
        association: {
            ref: { __id: association.id, __documentUri: association.documentUri },
            $refText: association.name ?? association.id
        },
        source: {
            ref: { __id: source.id, __documentUri: source.documentUri },
            $refText: source.name
        },
        target: {
            ref: { __id: target.id, __documentUri: target.documentUri },
            $refText: target.name
        },
        relationType: 'INSTANCE_LINK'
    };
}

export function planLinks(
    instances: readonly LinkableInstance[],
    associations: readonly AssociationView[],
    options: LinkPlanOptions
): LinkPlanResult {
    const patch: PatchOperation[] = [];
    const links: GeneratedLinkSummary[] = [];
    const diagnostics: GenerationDiagnostic[] = [];

    if (options.depth <= 0) {
        return { patch, links, diagnostics };
    }

    const rng = createRng(options.seed ?? 0);
    const idFactory = options.idFactory ?? randomUUID;
    const minPerSource = options.minPerSource ?? 0;
    const byClassifier = groupByClassifier(instances);

    for (const association of associations) {
        const allSources = byClassifier.get(association.sourceClassifierId) ?? [];
        const sources = options.sourceIds ? allSources.filter(source => options.sourceIds!.has(source.id)) : allSources;
        const targets = byClassifier.get(association.targetClassifierId) ?? [];
        if (sources.length === 0 || targets.length === 0) {
            continue;
        }

        const lower = association.targetLowerBound ?? 0;
        const upper = association.targetUpperBound ?? Number.POSITIVE_INFINITY;

        for (const source of sources) {
            // A target may be shared across sources, but never link an instance to itself.
            const candidates = targets.filter(target => target.id !== source.id);
            const maxLinks = Math.min(upper, candidates.length);
            // Effective lower honours the association's lower bound and the requested
            // minimum-per-source, but can never exceed the upper bound / available targets.
            const minLinks = Math.min(Math.max(lower, minPerSource), maxLinks);
            const count = minLinks >= maxLinks ? maxLinks : rng.int(minLinks, maxLinks);

            const chosen = pickDistinct(rng, candidates, count);
            if (chosen.length < lower) {
                diagnostics.push({
                    code: 'MULTIPLICITY_BEST_EFFORT',
                    severity: 'warning',
                    message: `Association '${association.name ?? association.id}': could only create ${chosen.length} of the required ${lower} link(s) for instance '${source.name}' (not enough target instances).`
                });
            }

            for (const target of chosen) {
                const id = idFactory();
                patch.push({ op: 'add', path: '/diagram/relations/-', value: buildLink(association, source, target, id) });
                links.push({
                    id,
                    name: association.name ?? association.id,
                    associationId: association.id,
                    sourceInstanceId: source.id,
                    targetInstanceId: target.id
                });
            }
        }
    }

    return { patch, links, diagnostics };
}
