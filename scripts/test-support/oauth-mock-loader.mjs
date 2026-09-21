const modules = {
  "expo-auth-session": `
    export function makeRedirectUri() {
      return "bangumini://oauth/callback";
    }
  `,
  "expo-secure-store": `
    function getStore() {
      return globalThis.__banguminiSecureStore;
    }
    export async function getItemAsync(key) {
      return getStore().get(key) ?? null;
    }
    export async function setItemAsync(key, value) {
      getStore().set(key, value);
    }
    export async function deleteItemAsync(key) {
      await globalThis.__banguminiBeforeSecureDelete?.(key);
      getStore().delete(key);
    }
    export async function setItem(key, value) {
      getStore().set(key, value);
    }
  `,
  "expo-web-browser": `
    export function maybeCompleteAuthSession() {}
    export async function openAuthSessionAsync() {
      throw new Error("openAuthSessionAsync is not used by this test");
    }
  `,
};

export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(modules, specifier)) {
    return {
      url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
