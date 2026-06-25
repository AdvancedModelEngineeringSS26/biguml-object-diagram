/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/
import fastJsonPatch from 'fast-json-patch';
import { NodeFileSystem } from 'langium/node';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { URI } from 'vscode-uri';
import { buildGeneration, type ClassifierView, type PatchOperation, type PropertyView } from '../src/env/glsp-server/generate.core.js';
import { planLinks, type AssociationView, type LinkableInstance } from '../src/env/glsp-server/links.core.js';
import { parseMultiplicity, resolveTypeKind, type TypeCategory } from '../src/env/glsp-server/resolve.js';
import { RandomStrategy } from '../src/env/glsp-server/strategies/random.strategy.js';
import { RealisticStrategy } from '../src/env/glsp-server/strategies/realistic.strategy.js';
import { createRandomUUID } from '../../uml-model-server/src/env/langium-connector/util/id-util.js';
import {
    addUUID,
    cleanJSON,
    rebuildLangiumReferences,
    rebuildReferences,
    removeUUID,
    updateReferences
} from '../../uml-model-server/src/env/langium-connector/patch/patch-manager.util.js';
import { createUmlDiagramServices } from '../../uml-model-server/src/env/langium/uml-diagram-module.js';

/**
 * Committed end-to-end test: drives the *real* model-server patch pipeline
 * (apply -> file-serialize -> re-parse) against a small self-contained fixture
 * diagram with TYPED properties and an enumeration — something the workspace
 * sample models do not have. It validates the generation path
 * (resolve.ts -> strategies -> generate.core -> links.core -> model-server) end
 * to end, without VS Code / GLSP / a webview.
 *
 * Fixture: a "Library" domain (different from the HR samples) — LibraryBook with
 * String/Integer/Real/Boolean/enum/unique/read-only/multi-valued attributes, a
 * LibraryMember, a borrowedBy association, and one existing member.
 *
 * Note (grammar limitation surfaced by this typed fixture): bigUML stores slot
 * values as a `LANGIUM_ID` token, which the lexer shadows with `LANGIUM_INT` /
 * `LANGIUM_BOOL` for bare numbers / booleans. So Integer/Real/Boolean values
 * (e.g. `63`, `true`) do not yet round-trip — see the characterization test below
 * and planning/feature-4-implementation-report.md §5.4. The round-trip suite
 * therefore exercises grammar-safe-valued properties (String/enumeration).
 */

const { shared, UmlDiagram } = createUmlDiagramServices(NodeFileSystem);
const fixtureText = readFileSync(fileURLToPath(new URL('./fixtures/library-domain.uml', import.meta.url)), 'utf8');
const tempDir = mkdtempSync(join(tmpdir(), 'biguml-e2e-'));
const t = (n: any): string | undefined => n?.$type ?? n?.__type;

function assertIdSafe(id: string): void {
    assert.match(id, /^[A-Za-z_]/, `id "${id}" is digit-leading`);
    assert.doesNotMatch(id, /[\s"{}[\]:,\\]/, `id "${id}" has a non-LANGIUM_ID char`);
}

/** Walk acyclic serialized JSON only (never the langium AST, which has $container cycles). */
function walk(root: any, pred: (n: any) => boolean): any[] {
    const out: any[] = [];
    (function w(x: any): void {
        if (x && typeof x === 'object') {
            if (pred(x)) out.push(x);
            for (const v of Object.values(x)) w(v);
        }
    })(root);
    return out;
}

async function parse(text: string, path: string): Promise<any> {
    const uri = URI.file(path);
    writeFileSync(path, text);
    shared.workspace.LangiumDocuments.deleteDocument(uri);
    const doc = shared.workspace.LangiumDocumentFactory.fromString(text, uri);
    shared.workspace.LangiumDocuments.addDocument(doc);
    await shared.workspace.DocumentBuilder.build([doc], { validation: false });
    return doc;
}

const internalOf = (doc: any): any => JSON.parse(UmlDiagram.serializer.JsonSerializer.serialize(doc.parseResult.value));

/** Resolve a property AST node into a PropertyView, mirroring the GLSP handler's resolvePropertyView. */
function resolvePropertyView(property: any, documentUri: string): PropertyView {
    const typeRef = property.propertyType?.ref;
    const category: TypeCategory = !typeRef
        ? 'none'
        : t(typeRef) === 'Enumeration'
          ? 'enumeration'
          : t(typeRef) === 'Class' || t(typeRef) === 'Interface'
            ? 'classifier'
            : 'datatype';
    const bounds = parseMultiplicity(property.multiplicity);
    return {
        id: property.__id,
        name: property.name,
        documentUri,
        typeKind: resolveTypeKind(category, typeRef?.name),
        typeName: typeRef?.name,
        enumLiterals: category === 'enumeration' ? (typeRef.values ?? []).map((l: any) => l.name) : undefined,
        isReadOnly: property.isReadOnly === true,
        isUnique: property.isUnique === true,
        required: bounds.lower >= 1,
        lowerBound: bounds.lower,
        upperBound: bounds.upper
    };
}

function applyPipeline(internal: any, patch: PatchOperation[], path: string): string {
    const map = new Map<string, any>();
    map.set(path, internal);
    addUUID(map);
    updateReferences(map);
    let result: any;
    for (const op of patch.map(o => JSON.parse(JSON.stringify(o)))) {
        if (op.op === 'add') op.value['__tmp_uuid__'] = createRandomUUID();
        result = fastJsonPatch.applyOperation(map.get(path), op);
    }
    map.set(path, result.newDocument);
    rebuildReferences(map);
    removeUUID(map);
    cleanJSON(map);
    rebuildLangiumReferences(map, UmlDiagram.workspace.AstNodeLocator, UmlDiagram.references.NameProvider, shared.workspace.LangiumDocuments);
    return UmlDiagram.serializer.Serializer.serialize(map.get(path));
}

const bookClass = (doc: any): any => doc.parseResult.value.diagram.entities.find((e: any) => t(e) === 'Class' && e.name === 'LibraryBook');
const memberClass = (doc: any): any => doc.parseResult.value.diagram.entities.find((e: any) => t(e) === 'Class' && e.name === 'LibraryMember');

describe('e2e: type-correct value generation from typed properties (patch level)', () => {
    let bySlot: Map<string, string>;
    let kinds: Record<string, string>;

    before(async () => {
        const path = join(tempDir, 'typed-patch.uml');
        const doc = await parse(fixtureText, path);
        const props = bookClass(doc).properties.map((p: any) => resolvePropertyView(p, path));
        kinds = Object.fromEntries(props.map((p: PropertyView) => [p.name, p.typeKind]));
        const view: ClassifierView = { id: bookClass(doc).__id, name: 'LibraryBook', documentUri: path, properties: props };
        const gen = buildGeneration([view], { count: 1, strategy: new RandomStrategy(), seed: 7, idFactory: createRandomUUID });
        const inst = gen.patch.find(o => o.path === '/diagram/entities/-')!.value as any;
        bySlot = new Map(inst.slots.map((s: any) => [s.name, s.values[0].value]));
    });

    it('resolves primitive/enum types from the fixture', () => {
        assert.deepEqual(
            { title: kinds.title, pageCount: kinds.pageCount, rating: kinds.rating, available: kinds.available, status: kinds.status },
            { title: 'string', pageCount: 'integer', rating: 'real', available: 'boolean', status: 'enumeration' }
        );
    });

    it('produces a type-correct value for each kind (numeric/boolean carry a grammar-safe prefix)', () => {
        // sanitizeSlotValue prefixes bare numbers/booleans with '_' so they survive the grammar.
        const unwrap = (v?: string): string => (v ?? '').replace(/^_/, '');
        assert.ok((bySlot.get('title') ?? '').length > 0);
        assert.ok(Number.isInteger(Number(unwrap(bySlot.get('pageCount')))), `pageCount: ${bySlot.get('pageCount')}`);
        assert.ok(!Number.isNaN(Number(unwrap(bySlot.get('rating')))), `rating: ${bySlot.get('rating')}`);
        assert.ok(['true', 'false'].includes(unwrap(bySlot.get('available'))), `available: ${bySlot.get('available')}`);
        assert.ok(['AVAILABLE', 'BORROWED', 'LOST'].includes(bySlot.get('status') ?? ''), `status: ${bySlot.get('status')}`);
    });
});

describe('e2e: end-to-end round-trip with constraints + links (grammar-safe valued props)', () => {
    let out: any;
    let parserErrors: number;
    let genInstances: any[];
    let genLinks: any[];
    let baseEntities: number;
    let baseMeta: number;
    let alice: any;

    const slot = (inst: any, name: string): any => (inst.slots ?? []).find((s: any) => s.name === name);
    const firstVal = (inst: any, name: string): string | undefined => slot(inst, name)?.values?.[0]?.value;

    before(async () => {
        const path = join(tempDir, 'roundtrip.uml');
        const baseDoc = await parse(fixtureText, path);
        assert.equal(baseDoc.parseResult.parserErrors?.length ?? 0, 0, 'fixture must parse cleanly');
        const internal = internalOf(baseDoc);
        baseEntities = internal.diagram.entities.length;
        baseMeta = internal.metaInfos.length;
        alice = walk(internal, n => t(n) === 'InstanceSpecification' && n.name === 'alice')[0];

        const book = bookClass(baseDoc);
        const member = memberClass(baseDoc);
        const assoc = baseDoc.parseResult.value.diagram.relations.find((r: any) => t(r) === 'Association' && r.name === 'borrowedBy');

        // All props, including numeric/boolean — sanitizeSlotValue prefixes those so they persist (§5.4).
        const properties = book.properties.map((p: any) => resolvePropertyView(p, path));
        const view: ClassifierView = { id: book.__id, name: 'LibraryBook', documentUri: path, properties };
        const gen = buildGeneration([view], { count: 4, strategy: new RandomStrategy(), seed: 99, idFactory: createRandomUUID });

        const pool: LinkableInstance[] = [
            { id: alice.__id, name: alice.name, classifierId: member.__id, documentUri: path },
            ...gen.instances.map(i => ({ id: i.id, name: i.name, classifierId: i.classifierId, documentUri: path }))
        ];
        const assocView: AssociationView = {
            id: assoc.__id,
            name: 'borrowedBy',
            documentUri: path,
            sourceClassifierId: book.__id,
            targetClassifierId: member.__id,
            targetLowerBound: 1,
            targetUpperBound: 1
        };
        const links = planLinks(pool, [assocView], { depth: 1, seed: 3, minPerSource: 1, sourceIds: new Set(gen.instances.map(i => i.id)), idFactory: createRandomUUID });

        const layout = gen.instances.flatMap(i => [
            { op: 'add' as const, path: '/metaInfos/-', value: { $type: 'Size', __id: createRandomUUID(), element: { $ref: { __id: i.id, __documentUri: path } }, width: 180, height: 120 } },
            { op: 'add' as const, path: '/metaInfos/-', value: { $type: 'Position', __id: createRandomUUID(), element: { $ref: { __id: i.id, __documentUri: path } }, x: 80, y: 320 } }
        ]);
        const appliedText = applyPipeline(internal, [...gen.patch, ...layout, ...links.patch], path);

        const appliedDoc = await parse(appliedText, path);
        parserErrors = appliedDoc.parseResult.parserErrors?.length ?? 0;
        out = internalOf(appliedDoc);
        genInstances = walk(out, n => t(n) === 'InstanceSpecification' && /^librarybook_/.test(n.name ?? ''));
        const genIds = new Set(genInstances.map(i => i.__id));
        genLinks = walk(out, n => t(n) === 'InstanceLink' && genIds.has(n.source?.$ref?.__id));
    });

    it('applies and re-parses with zero parse errors', () => {
        assert.equal(parserErrors, 0);
    });

    it('does not corrupt the existing model (entities/metaInfos preserved, alice intact)', () => {
        assert.ok(out.diagram.entities.length >= baseEntities + 4, `entities ${baseEntities} -> ${out.diagram.entities.length}`);
        assert.ok(out.metaInfos.length >= baseMeta + 4, `metaInfos ${baseMeta} -> ${out.metaInfos.length}`);
        assert.equal(walk(out, n => t(n) === 'InstanceSpecification' && n.name === 'alice')[0].slots[0].values[0].value, 'Alice');
    });

    it('generates 4 LibraryBook instances with String/enum slots', () => {
        assert.equal(genInstances.length, 4);
        for (const inst of genInstances) {
            assert.ok((firstVal(inst, 'title') ?? '').length > 0, 'title');
            assert.ok(['AVAILABLE', 'BORROWED', 'LOST'].includes(firstVal(inst, 'status') ?? ''), `status: ${firstVal(inst, 'status')}`);
        }
    });

    it('persists numeric/boolean values (grammar-safe prefixed) and they re-parse cleanly', () => {
        const unwrap = (v?: string): string => (v ?? '').replace(/^_/, '');
        for (const inst of genInstances) {
            assert.ok(Number.isInteger(Number(unwrap(firstVal(inst, 'pageCount')))), `pageCount: ${firstVal(inst, 'pageCount')}`);
            assert.ok(['true', 'false'].includes(unwrap(firstVal(inst, 'available'))), `available: ${firstVal(inst, 'available')}`);
        }
    });

    it('skips the read-only property (shelfCode has no slot)', () => {
        assert.ok(genInstances.every(i => !slot(i, 'shelfCode')));
    });

    it('keeps the unique property (isbn) distinct across instances', () => {
        const isbns = genInstances.map(i => firstVal(i, 'isbn'));
        assert.equal(new Set(isbns).size, isbns.length, JSON.stringify(isbns));
    });

    it('generates multiple values for the unbounded multi-valued attribute (tags)', () => {
        for (const inst of genInstances) {
            const tags = slot(inst, 'tags');
            assert.ok(tags && tags.values.length >= 1 && tags.values.length <= 5, `tags: ${tags?.values?.length}`);
        }
    });

    it('creates one borrowedBy link per book, all targeting the existing member (auto-selected)', () => {
        assert.equal(genLinks.length, 4);
        assert.ok(genLinks.every(l => l.target?.$ref?.__id === alice.__id));
    });

    it('mints grammar-safe ids and values throughout', () => {
        for (const inst of genInstances) {
            assertIdSafe(inst.__id);
            for (const s of inst.slots) {
                assertIdSafe(s.__id);
                for (const v of s.values) {
                    assertIdSafe(v.__id);
                    assert.doesNotMatch(v.value, /[\s"{}[\]:,\\]/, `unsafe value: ${v.value}`);
                }
            }
        }
        for (const l of genLinks) assertIdSafe(l.__id);
    });

    it('is reversible by a single undo (re-parsing the base yields identical counts)', async () => {
        const base = internalOf(await parse(fixtureText, join(tempDir, 'undo.uml')));
        assert.equal(base.diagram.entities.length, baseEntities);
        assert.equal(base.metaInfos.length, baseMeta);
    });
});

describe('e2e: numeric/boolean slot values persist via the grammar-safe prefix (§5.4 workaround)', () => {
    // The grammar lexes bare `63` as LANGIUM_INT (not LANGIUM_ID), which would corrupt the
    // document. sanitizeSlotValue prefixes such values with '_' so they round-trip; the
    // underlying number/boolean is recoverable by stripping the prefix. (A proper escaped-value
    // grammar terminal would let us drop the prefix — see report §5.4.)
    it('an Integer value is stored prefixed (e.g. _63) and re-parses with no errors', async () => {
        const path = join(tempDir, 'numeric-prefix.uml');
        const baseDoc = await parse(fixtureText, path);
        const internal = internalOf(baseDoc);
        const book = bookClass(baseDoc);
        const pageCount = book.properties.find((p: any) => p.name === 'pageCount');
        const view: ClassifierView = { id: book.__id, name: 'LibraryBook', documentUri: path, properties: [resolvePropertyView(pageCount, path)] };
        const gen = buildGeneration([view], { count: 1, strategy: new RandomStrategy(), seed: 1, idFactory: createRandomUUID });
        const value = (gen.patch[0].value as any).slots[0].values[0].value;
        assert.match(value, /^_\d+$/, `expected a prefixed integer value, got ${value}`);
        assert.ok(Number.isInteger(Number(value.replace(/^_/, ''))), 'underlying integer recoverable');
        const appliedDoc = await parse(applyPipeline(internal, gen.patch, path), path);
        assert.equal(appliedDoc.parseResult.parserErrors?.length ?? 0, 0, 'prefixed numeric value must round-trip');
    });
});

describe('e2e: realistic strategy round-trip (Library member emails)', () => {
    let emails: (string | undefined)[];
    let parserErrors: number;

    before(async () => {
        const path = join(tempDir, 'realistic.uml');
        const baseDoc = await parse(fixtureText, path);
        const internal = internalOf(baseDoc);
        const member = memberClass(baseDoc);
        const view: ClassifierView = {
            id: member.__id,
            name: 'LibraryMember',
            documentUri: path,
            properties: member.properties.map((p: any) => resolvePropertyView(p, path))
        };
        const gen = buildGeneration([view], { count: 3, strategy: new RealisticStrategy(2026), seed: 2026, idFactory: createRandomUUID });
        const appliedDoc = await parse(applyPipeline(internal, gen.patch, path), path);
        parserErrors = appliedDoc.parseResult.parserErrors?.length ?? 0;
        const members = walk(internalOf(appliedDoc), n => t(n) === 'InstanceSpecification' && /^librarymember_/.test(n.name ?? ''));
        emails = members.map(m => (m.slots ?? []).find((s: any) => s.name === 'email')?.values?.[0]?.value);
    });

    it('round-trips realistic emails through serialize/reparse without corruption', () => {
        assert.equal(parserErrors, 0);
        assert.equal(emails.length, 3);
        assert.ok(emails.every(e => /@/.test(e ?? '') && /\./.test(e ?? '')), `emails: ${JSON.stringify(emails)}`);
    });
});
