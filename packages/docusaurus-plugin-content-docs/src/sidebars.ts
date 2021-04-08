/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'fs-extra';
import importFresh from 'import-fresh';
import {
  Sidebars,
  SidebarItem,
  SidebarItemBase,
  SidebarItemLink,
  SidebarItemDoc,
  Sidebar,
  SidebarItemCategory,
  SidebarItemType,
  UnprocessedSidebarItem,
  UnprocessedSidebars,
  UnprocessedSidebar,
  DocMetadataBase,
  SidebarItemAutogenerated,
} from './types';
import {
  mapValues,
  flatten,
  flatMap,
  difference,
  sortBy,
  take,
  last,
} from 'lodash';
import {addTrailingSlash, getElementsAround} from '@docusaurus/utils';
import combinePromises from 'combine-promises';
import {stripNumberPrefix} from './numberPrefix';
import chalk from 'chalk';

type SidebarItemCategoryJSON = SidebarItemBase & {
  type: 'category';
  label: string;
  items: SidebarItemJSON[];
  collapsed?: boolean;
};

type SidebarItemAutogeneratedJSON = {
  type: 'autogenerated';
  dirPath: string;
};

type SidebarItemJSON =
  | string
  | SidebarCategoryShorthandJSON
  | SidebarItemDoc
  | SidebarItemLink
  | SidebarItemCategoryJSON
  | SidebarItemAutogeneratedJSON
  | {
      type: string;
      [key: string]: unknown;
    };

type SidebarCategoryShorthandJSON = {
  [sidebarCategory: string]: SidebarItemJSON[];
};

type SidebarJSON = SidebarCategoryShorthandJSON | SidebarItemJSON[];

// Sidebar given by user that is not normalized yet. e.g: sidebars.json
type SidebarsJSON = {
  [sidebarId: string]: SidebarJSON;
};

function isCategoryShorthand(
  item: SidebarItemJSON,
): item is SidebarCategoryShorthandJSON {
  return typeof item !== 'string' && !item.type;
}

// categories are collapsed by default, unless user set collapsed = false
const defaultCategoryCollapsedValue = true;

/**
 * Convert {category1: [item1,item2]} shorthand syntax to long-form syntax
 */
function normalizeCategoryShorthand(
  sidebar: SidebarCategoryShorthandJSON,
): SidebarItemCategoryJSON[] {
  return Object.entries(sidebar).map(([label, items]) => ({
    type: 'category',
    collapsed: defaultCategoryCollapsedValue,
    label,
    items,
  }));
}

/**
 * Check that item contains only allowed keys.
 */
function assertItem<K extends string>(
  item: Record<string, unknown>,
  keys: K[],
): asserts item is Record<K, unknown> {
  const unknownKeys = Object.keys(item).filter(
    // @ts-expect-error: key is always string
    (key) => !keys.includes(key as string) && key !== 'type',
  );

  if (unknownKeys.length) {
    throw new Error(
      `Unknown sidebar item keys: ${unknownKeys}. Item: ${JSON.stringify(
        item,
      )}`,
    );
  }
}

function assertIsCategory(
  item: Record<string, unknown>,
): asserts item is SidebarItemCategoryJSON {
  assertItem(item, ['items', 'label', 'collapsed', 'customProps']);
  if (typeof item.label !== 'string') {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "label" must be a string.`,
    );
  }
  if (!Array.isArray(item.items)) {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "items" must be an array.`,
    );
  }
  // "collapsed" is an optional property
  if (item.hasOwnProperty('collapsed') && typeof item.collapsed !== 'boolean') {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "collapsed" must be a boolean.`,
    );
  }
}

function assertIsAutogenerated(
  item: Record<string, unknown>,
): asserts item is SidebarItemAutogeneratedJSON {
  assertItem(item, ['dirPath']);
  if (typeof item.dirPath !== 'string') {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "dirPath" must be a string.`,
    );
  }
  if (item.dirPath.startsWith('/') || item.dirPath.endsWith('/')) {
    throw new Error(
      `Error loading ${JSON.stringify(
        item,
      )}. "dirPath" must be a dir path relative to the docs folder root, and should not start or end with /`,
    );
  }
}

function assertIsDoc(
  item: Record<string, unknown>,
): asserts item is SidebarItemDoc {
  assertItem(item, ['id', 'label', 'customProps']);
  if (typeof item.id !== 'string') {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "id" must be a string.`,
    );
  }

  if (item.label && typeof item.label !== 'string') {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "label" must be a string.`,
    );
  }
}

function assertIsLink(
  item: Record<string, unknown>,
): asserts item is SidebarItemLink {
  assertItem(item, ['href', 'label', 'customProps']);
  if (typeof item.href !== 'string') {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "href" must be a string.`,
    );
  }
  if (typeof item.label !== 'string') {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "label" must be a string.`,
    );
  }
}

/**
 * Normalizes recursively item and all its children. Ensures that at the end
 * each item will be an object with the corresponding type.
 */
function normalizeItem(item: SidebarItemJSON): UnprocessedSidebarItem[] {
  if (typeof item === 'string') {
    return [
      {
        type: 'doc',
        id: item,
      },
    ];
  }
  if (isCategoryShorthand(item)) {
    return flatMap(normalizeCategoryShorthand(item), normalizeItem);
  }
  switch (item.type) {
    case 'category':
      assertIsCategory(item);
      return [
        {
          collapsed: defaultCategoryCollapsedValue,
          ...item,
          items: flatMap(item.items, normalizeItem),
        },
      ];
    case 'autogenerated':
      assertIsAutogenerated(item);
      return [item];
    case 'link':
      assertIsLink(item);
      return [item];
    case 'ref':
    case 'doc':
      assertIsDoc(item);
      return [item];
    default: {
      const extraMigrationError =
        item.type === 'subcategory'
          ? "Docusaurus v2: 'subcategory' has been renamed as 'category'"
          : '';
      throw new Error(
        `Unknown sidebar item type [${
          item.type
        }]. Sidebar item=${JSON.stringify(item)} ${extraMigrationError}`,
      );
    }
  }
}

function normalizeSidebar(sidebar: SidebarJSON): UnprocessedSidebar {
  const normalizedSidebar: SidebarItemJSON[] = Array.isArray(sidebar)
    ? sidebar
    : normalizeCategoryShorthand(sidebar);

  return flatMap(normalizedSidebar, normalizeItem);
}

function normalizeSidebars(sidebars: SidebarsJSON): UnprocessedSidebars {
  return mapValues(sidebars, normalizeSidebar);
}

export const DefaultSidebars: UnprocessedSidebars = {
  defaultSidebar: [
    {
      type: 'autogenerated',
      dirPath: '.',
    },
  ],
};

// TODO refactor: make async
export function loadSidebars(sidebarFilePath: string): UnprocessedSidebars {
  if (!sidebarFilePath) {
    throw new Error(`sidebarFilePath not provided: ${sidebarFilePath}`);
  }

  // No sidebars file: by default we use the file-system structure to generate the sidebar
  // See https://github.com/facebook/docusaurus/pull/4582
  if (!fs.existsSync(sidebarFilePath)) {
    // TODO temporary: we should throw instead! Default sidebars is when sidebarPath is not configured!
    return DefaultSidebars;
  }

  // We don't want sidebars to be cached because of hot reloading.
  const sidebarJson = importFresh(sidebarFilePath) as SidebarsJSON;
  return normalizeSidebars(sidebarJson);
}

async function transformAutogeneratedSidebarItem(
  autogeneratedItem: SidebarItemAutogenerated,
  allDocs: DocMetadataBase[],
): Promise<SidebarItem[]> {
  // Doc at the root of the autogenerated sidebar dir
  function isRootDoc(doc: DocMetadataBase) {
    return doc.sourceDirName === autogeneratedItem.dirPath;
  }

  // Doc inside a subfolder of the autogenerated sidebar dir
  function isCategoryDoc(doc: DocMetadataBase) {
    if (isRootDoc(doc)) {
      return false;
    }

    return (
      // autogen dir is . and doc is in subfolder
      autogeneratedItem.dirPath === '.' ||
      // autogen dir is not . and doc is in subfolder
      // "api/myDoc" startsWith "api/" (note "api2/myDoc" is not included)
      doc.sourceDirName.startsWith(addTrailingSlash(autogeneratedItem.dirPath))
    );
  }

  function isInAutogeneratedDir(doc: DocMetadataBase) {
    return isRootDoc(doc) || isCategoryDoc(doc);
  }

  // autogenDir=a/b and docDir=a/b/c/d => returns c/d
  // autogenDir=a/b and docDir=a/b => returns .
  function getDocDirRelativeToAutogenDir(doc: DocMetadataBase): string {
    if (!isInAutogeneratedDir(doc)) {
      throw new Error(
        'getDocDirRelativeToAutogenDir() can only be called for  subdocs of the sidebar autogen dir',
      );
    }
    if (autogeneratedItem.dirPath === '.') {
      return doc.sourceDirName;
    } else {
      return doc.sourceDirName.replace(
        addTrailingSlash(autogeneratedItem.dirPath),
        '',
      );
    }
  }

  /*
  console.log(
    'allDocs',
    allDocs.map((d) => ({
      source: d.source,
      dir: d.sourceDirName,
      isRootDoc: isRootDoc(d),
      isCategoryDoc: isCategoryDoc(d),
    })),
  );
   */

  const docsUnsorted: DocMetadataBase[] = allDocs.filter(
    (doc) => isRootDoc(doc) || isCategoryDoc(doc),
  );
  // Sort by folder+filename at once
  const docs = sortBy(docsUnsorted, (d) => d.source);

  if (docs.length === 0) {
    console.warn(
      chalk.yellow(
        `No docs found in dir ${autogeneratedItem.dirPath}: can't auto-generate a sidebar`,
      ),
    );
  }

  /*
  console.log(
    'docs',
    docs.map((d) => ({
      source: d.source,
      dir: d.sourceDirName,
    })),
  );
   */

  function createDocSidebarItem(doc: DocMetadataBase): SidebarItemDoc {
    return {
      type: 'doc',
      id: doc.id,
      ...(doc.frontMatter.sidebar_label && {
        label: doc.frontMatter.sidebar_label,
      }),
    };
  }

  async function createCategorySidebarItem({
    dirName,
  }: {
    dirName: string;
  }): Promise<SidebarItemCategory> {
    // TODO read metadata file from the directory for additional config?
    return {
      type: 'category',
      label: stripNumberPrefix(dirName),
      items: [],
      collapsed: true, // TODO use default value
    };
  }

  // Not sure how to simplify this algorithm :/
  async function autogenerateSidebarItems(): Promise<SidebarItem[]> {
    const BreadcrumbSeparator = '/';

    const sidebarItems: SidebarItem[] = []; // mutable result

    const categoriesByBreadcrumb: Record<string, SidebarItemCategory> = {}; // mutable cache of categories already created

    async function getOrCreateCategoriesForBreadcrumb(
      breadcrumb: string[],
    ): Promise<SidebarItemCategory | null> {
      if (breadcrumb.length === 0) {
        return null;
      }
      const parentBreadcrumb = take(breadcrumb, breadcrumb.length - 1);
      const lastBreadcrumbElement = last(breadcrumb)!;
      const parentCategory = await getOrCreateCategoriesForBreadcrumb(
        parentBreadcrumb,
      );
      const existingCategory =
        categoriesByBreadcrumb[breadcrumb.join(BreadcrumbSeparator)];

      if (existingCategory) {
        return existingCategory;
      } else {
        const newCategory = await createCategorySidebarItem({
          dirName: lastBreadcrumbElement,
        });
        if (parentCategory) {
          parentCategory.items.push(newCategory);
        } else {
          sidebarItems.push(newCategory);
        }
        categoriesByBreadcrumb[
          breadcrumb.join(BreadcrumbSeparator)
        ] = newCategory;
        return newCategory;
      }
    }

    // Get the category breadcrumb of a doc (relative to the dir of the autogenerated sidebar item)
    function getBreadcrumb(doc: DocMetadataBase): string[] {
      const relativeDirPath = getDocDirRelativeToAutogenDir(doc);
      if (relativeDirPath === '.') {
        return [];
      } else {
        return relativeDirPath.split(BreadcrumbSeparator);
      }
    }

    async function handleDocItem(doc: DocMetadataBase): Promise<void> {
      const breadcrumb = getBreadcrumb(doc);
      const category = await getOrCreateCategoriesForBreadcrumb(breadcrumb);

      const docSidebarItem = createDocSidebarItem(doc);
      if (category) {
        category.items.push(docSidebarItem);
      } else {
        sidebarItems.push(docSidebarItem);
      }
    }

    // async process made sequential on purpose! order matters
    for (const doc of docs) {
      // eslint-disable-next-line no-await-in-loop
      await handleDocItem(doc);
    }

    console.log({sidebarItems});

    return sidebarItems;
  }

  return autogenerateSidebarItems();
}

export async function processSidebar(
  unprocessedSidebar: UnprocessedSidebar,
  allDocs: DocMetadataBase[],
): Promise<Sidebar> {
  async function processRecursive(
    item: UnprocessedSidebarItem,
  ): Promise<SidebarItem[]> {
    if (item.type === 'category') {
      return [
        {
          ...item,
          items: (await Promise.all(item.items.map(processRecursive))).flat(),
        },
      ];
    }
    if (item.type === 'autogenerated') {
      return transformAutogeneratedSidebarItem(item, allDocs);
    }
    return [item];
  }

  return (await Promise.all(unprocessedSidebar.map(processRecursive))).flat();
}

export async function processSidebars(
  unprocessedSidebars: UnprocessedSidebars,
  docs: DocMetadataBase[],
): Promise<Sidebars> {
  return combinePromises(
    mapValues(unprocessedSidebars, (sidebar) => processSidebar(sidebar, docs)),
  );
}

function collectSidebarItemsOfType<
  Type extends SidebarItemType,
  Item extends SidebarItem & {type: SidebarItemType}
>(type: Type, sidebar: Sidebar): Item[] {
  function collectRecursive(item: SidebarItem): Item[] {
    const currentItemsCollected: Item[] =
      item.type === type ? [item as Item] : [];

    const childItemsCollected: Item[] =
      item.type === 'category' ? flatten(item.items.map(collectRecursive)) : [];

    return [...currentItemsCollected, ...childItemsCollected];
  }

  return flatten(sidebar.map(collectRecursive));
}

export function collectSidebarDocItems(sidebar: Sidebar): SidebarItemDoc[] {
  return collectSidebarItemsOfType('doc', sidebar);
}
export function collectSidebarCategories(
  sidebar: Sidebar,
): SidebarItemCategory[] {
  return collectSidebarItemsOfType('category', sidebar);
}
export function collectSidebarLinks(sidebar: Sidebar): SidebarItemLink[] {
  return collectSidebarItemsOfType('link', sidebar);
}

export function transformSidebarItems(
  sidebar: Sidebar,
  updateFn: (item: SidebarItem) => SidebarItem,
): Sidebar {
  function transformRecursive(item: SidebarItem): SidebarItem {
    if (item.type === 'category') {
      return updateFn({
        ...item,
        items: item.items.map(transformRecursive),
      });
    }
    return updateFn(item);
  }
  return sidebar.map(transformRecursive);
}

export function collectSidebarsDocIds(
  sidebars: Sidebars,
): Record<string, string[]> {
  return mapValues(sidebars, (sidebar) => {
    return collectSidebarDocItems(sidebar).map((docItem) => docItem.id);
  });
}

export function createSidebarsUtils(sidebars: Sidebars) {
  const sidebarNameToDocIds = collectSidebarsDocIds(sidebars);

  function getFirstDocIdOfFirstSidebar(): string | undefined {
    return Object.values(sidebarNameToDocIds)[0]?.[0];
  }

  function getSidebarNameByDocId(docId: string): string | undefined {
    // TODO lookup speed can be optimized
    const entry = Object.entries(
      sidebarNameToDocIds,
    ).find(([_sidebarName, docIds]) => docIds.includes(docId));

    return entry?.[0];
  }

  function getDocNavigation(
    docId: string,
  ): {
    sidebarName: string | undefined;
    previousId: string | undefined;
    nextId: string | undefined;
  } {
    const sidebarName = getSidebarNameByDocId(docId);
    if (sidebarName) {
      const docIds = sidebarNameToDocIds[sidebarName];
      const currentIndex = docIds.indexOf(docId);
      const {previous, next} = getElementsAround(docIds, currentIndex);
      return {
        sidebarName,
        previousId: previous,
        nextId: next,
      };
    } else {
      return {
        sidebarName: undefined,
        previousId: undefined,
        nextId: undefined,
      };
    }
  }

  function checkSidebarsDocIds(validDocIds: string[]) {
    const allSidebarDocIds = flatten(Object.values(sidebarNameToDocIds));
    const invalidSidebarDocIds = difference(allSidebarDocIds, validDocIds);
    if (invalidSidebarDocIds.length > 0) {
      throw new Error(
        `Bad sidebars file.
These sidebar document ids do not exist:
- ${invalidSidebarDocIds.sort().join('\n- ')},

Available document ids=
- ${validDocIds.sort().join('\n- ')}`,
      );
    }
  }

  return {
    getFirstDocIdOfFirstSidebar,
    getSidebarNameByDocId,
    getDocNavigation,
    checkSidebarsDocIds,
  };
}
