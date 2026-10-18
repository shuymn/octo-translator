import { storage } from "wxt/utils/storage";
import type { Cache } from "./cache.ts";

// Everything lives in storage.local: storage.sync would copy the API key to every signed-in browser.

export const apiKeyItem = storage.defineItem<string>("local:apiKey", { fallback: "" });

// Off by default: each new pull request opened would spend a request of the free tier.
export const autoTranslateItem = storage.defineItem<boolean>("local:autoTranslate", { fallback: false });

// Private repositories the owner allows, as lowercase `owner/repo`. The free tier may use what it is sent to improve
// Google's products, so private repositories are not translated unless listed here.
export const privateRepositoriesItem = storage.defineItem<string[]>("local:privateRepositories", { fallback: [] });

export const cacheItem = storage.defineItem<Cache>("local:translations", { fallback: {} });
