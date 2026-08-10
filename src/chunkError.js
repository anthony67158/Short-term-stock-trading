export function isChunkLoadError(error) {
  const message = String(error?.message || error || '')
  return /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk .* failed/i.test(message)
}

export function chunkReloadKey(chunkName) {
  return `chunk_reload_once:${chunkName}`
}

export function shouldReloadChunk(error, chunkName, storage = sessionStorage) {
  if (!isChunkLoadError(error)) return false
  const key = chunkReloadKey(chunkName)
  if (storage.getItem(key)) return false
  storage.setItem(key, String(Date.now()))
  return true
}
