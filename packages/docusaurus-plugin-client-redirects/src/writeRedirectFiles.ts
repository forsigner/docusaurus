/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'fs-extra';
import path from 'path';
import {memoize} from 'lodash';

import {PluginContext, RedirectMetadata} from './types';
import createRedirectPageContent from './createRedirectPageContent';
import {getFilePathForRoutePath, normalizeUrl} from '@docusaurus/utils';

export type WriteFilesPluginContext = Pick<PluginContext, 'baseUrl' | 'outDir'>;

export type RedirectFileMetadata = {
  fileAbsolutePath: string;
  fileContent: string;
};

export function createToUrl(baseUrl: string, to: string): string {
  return normalizeUrl([baseUrl, to]);
}

export function toRedirectFilesMetadata(
  redirects: RedirectMetadata[],
  pluginContext: WriteFilesPluginContext,
  trailingSlash: boolean | undefined,
): RedirectFileMetadata[] {
  // Perf: avoid rendering the template twice with the exact same "props"
  // We might create multiple redirect pages for the same destination url
  // note: the first fn arg is the cache key!
  const createPageContentMemoized = memoize((toUrl: string) => {
    return createRedirectPageContent({toUrl});
  });

  const createFileMetadata = (redirect: RedirectMetadata) => {
    const filePath = getFilePathForRoutePath(redirect.from, trailingSlash);
    const fileAbsolutePath = path.join(pluginContext.outDir, filePath);
    const toUrl = createToUrl(pluginContext.baseUrl, redirect.to);
    const fileContent = createPageContentMemoized(toUrl);
    return {
      ...redirect,
      fileAbsolutePath,
      fileContent,
    };
  };

  return redirects.map(createFileMetadata);
}

export async function writeRedirectFile(
  file: RedirectFileMetadata,
): Promise<void> {
  try {
    // User-friendly security to prevent file overrides
    if (await fs.pathExists(file.fileAbsolutePath)) {
      throw new Error(
        'The redirect plugin is not supposed to override existing files.',
      );
    }
    await fs.ensureDir(path.dirname(file.fileAbsolutePath));
    await fs.writeFile(
      file.fileAbsolutePath,
      file.fileContent,
      // Hard security to prevent file overrides
      // See https://stackoverflow.com/a/34187712/82609
      {flag: 'wx'},
    );
  } catch (err) {
    throw new Error(
      `Redirect file creation error for "${file.fileAbsolutePath}" path: ${err}.`,
    );
  }
}

export default async function writeRedirectFiles(
  redirectFiles: RedirectFileMetadata[],
): Promise<void> {
  await Promise.all(redirectFiles.map(writeRedirectFile));
}
