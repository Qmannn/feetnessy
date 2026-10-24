/// <reference types="vite-plugin-pwa/client" />

import { registerSW } from 'virtual:pwa-register';

/** Notify the UI, but activate a waiting worker only after an explicit user action. */
export function registerPwa(onUpdate: () => void): () => Promise<void> {
  const update = registerSW({
    immediate: true,
    onNeedRefresh: onUpdate,
    onRegisterError(error: unknown) {
      console.error('Не удалось включить офлайн-режим Feetnessy:', error);
    },
  });

  return async () => {
    await update(true);
  };
}
