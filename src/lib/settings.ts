import { storage } from "wxt/utils/storage";
import type { Cache } from "./cache.ts";
import { DEFAULT_CHOICE } from "./providers.ts";

// Everything lives in storage.local, where storage.sync would copy it to every signed-in browser. The API keys are in
// `api-keys.ts`, which the content script does not import (KEY-1).

// The provider, model and thinking level, in one item so they are always written together. Read it through
// `resolveChoice`: a stored value may name a model the table no longer offers.
export const modelChoiceItem = storage.defineItem<unknown>("local:modelChoice", { fallback: DEFAULT_CHOICE });

// Off by default: each new pull request opened would spend a request.
export const autoTranslateItem = storage.defineItem<boolean>("local:autoTranslate", { fallback: false });

// Private repositories the owner allows, as lowercase `owner/repo`. A provider may keep or train on what it is sent,
// so private repositories are not translated unless listed here.
export const privateRepositoriesItem = storage.defineItem<string[]>("local:privateRepositories", { fallback: [] });

export const cacheItem = storage.defineItem<Cache>("local:translations", { fallback: {} });
