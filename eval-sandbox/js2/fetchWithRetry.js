export async function fetchWithRetry(url, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
