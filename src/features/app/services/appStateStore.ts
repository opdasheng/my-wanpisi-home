// --- 硬核阉割版：彻底告别 Fetch 请求，转向浏览器本地存储 ---

export type PersistedAppStateEntry<T> = {
  key: string;
  value: T | null;
  updatedAt: string | null;
};

/**
 * 模拟原有的异步请求，但实际上是操作浏览器的 LocalStorage
 * 这样就不再需要调用那个该死的 SeedanceBridge 了
 */
export async function loadPersistedAppState<T>(key: string, _baseUrl?: string): Promise<PersistedAppStateEntry<T>> {
  console.log(`[MockAppStateStore] Loading key: ${key}`);
  try {
    const data = localStorage.getItem(`oneflow_storage_${key}`);
    return {
      key,
      value: data ? JSON.parse(data) : null,
      updatedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error(`[MockAppStateStore] Load error for ${key}:`, e);
    return { key, value: null, updatedAt: null };
  }
}

export async function savePersistedAppState<T>(key: string, value: T, _baseUrl?: string): Promise<PersistedAppStateEntry<T>> {
  console.log(`[MockAppStateStore] Saving key: ${key}`);
  try {
    localStorage.setItem(`oneflow_storage_${key}`, JSON.stringify(value));
    return {
      key,
      value: value,
      updatedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error(`[MockAppStateStore] Save error for ${key}:`, e);
    // 这里绝对不 throw Error，也不弹窗，确保程序继续运行
    return { key, value: null, updatedAt: null };
  }
}
