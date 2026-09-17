import {
  hasStorage,
  list,
  put,
  readJson,
} from './_blob.js'
import {
  LEARNING_PREFIX,
  learningContentHash,
  learningEventPath,
} from '../shared/learningEvent.js'

function conflict(error) {
  return error?.status === 409
    || ['FileAlreadyExists', 'ObjectAlreadyExists']
      .includes(error?.code)
}

function jsonOptions() {
  return {
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
    forbidOverwrite: true,
  }
}

function artifactPath(path) {
  const value = String(path || '').replace(/^\/+/, '')
  if (
    !/^learning\/v1\/(?:views|manifests|training-runs)\/[a-zA-Z0-9/._:-]+$/
      .test(value)
  ) {
    throw new Error('学习产物路径无效')
  }
  return value
}

export function createLearningStore(storage = {
  hasStorage,
  list,
  put,
  readJson,
}) {
  const memory = new Map()

  return {
    async saveEvent(event) {
      const path = learningEventPath(event)
      if (!storage.hasStorage()) {
        const current = memory.get(path)
        if (!current) {
          memory.set(path, event)
          return event
        }
        if (current.contentHash !== event.contentHash) {
          throw new Error('LEARNING_EVENT_IMMUTABLE_CONFLICT')
        }
        return current
      }
      try {
        await storage.put(path, JSON.stringify(event), jsonOptions())
        return event
      } catch (error) {
        if (!conflict(error)) throw error
        const current = await storage.readJson(path)
        if (!current || current.contentHash !== event.contentHash) {
          throw new Error('LEARNING_EVENT_IMMUTABLE_CONFLICT')
        }
        return current
      }
    },

    async readEvent(event) {
      const path = learningEventPath(event)
      if (!storage.hasStorage()) return memory.get(path) || null
      return storage.readJson(path).catch(() => null)
    },

    async listEvents({
      kind = '',
      tradeDate = '',
      limit = 10000,
    } = {}) {
      const suffix = [
        String(kind || '').trim(),
        String(tradeDate || '').trim(),
      ].filter(Boolean).join('/')
      const prefix = `${LEARNING_PREFIX}${suffix}${suffix ? '/' : ''}`
      const maximum = Math.max(
        1,
        Math.min(10000, Math.trunc(Number(limit) || 10000)),
      )
      if (!storage.hasStorage()) {
        return [...memory.entries()]
          .filter(([path]) => path.startsWith(prefix))
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, maximum)
          .map(([, value]) => value)
      }
      const { blobs = [] } = await storage.list({
        prefix,
        limit: maximum,
      })
      const values = await Promise.all(blobs.map((blob) =>
        storage.readJson(blob.pathname || blob).catch(() => null),
      ))
      return values.filter(Boolean)
    },

    async saveArtifact(path, value) {
      const target = artifactPath(path)
      const envelope = {
        ...value,
        contentHash: learningContentHash(value),
      }
      if (!storage.hasStorage()) {
        const current = memory.get(target)
        if (!current) {
          memory.set(target, envelope)
          return envelope
        }
        if (current.contentHash !== envelope.contentHash) {
          throw new Error('LEARNING_ARTIFACT_IMMUTABLE_CONFLICT')
        }
        return current
      }
      try {
        await storage.put(
          target,
          JSON.stringify(envelope),
          jsonOptions(),
        )
        return envelope
      } catch (error) {
        if (!conflict(error)) throw error
        const current = await storage.readJson(target)
        if (!current || current.contentHash !== envelope.contentHash) {
          throw new Error('LEARNING_ARTIFACT_IMMUTABLE_CONFLICT')
        }
        return current
      }
    },
  }
}

export const learningStore = createLearningStore()
