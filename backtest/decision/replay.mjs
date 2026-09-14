import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

import {
  executeDecisionReplayPacket,
} from '../../shared/decisionReplayPacket.js'

export function replayDecisionPacket(packet) {
  return executeDecisionReplayPacket(packet)
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const input = process.argv[2]
  if (!input) {
    throw new Error(
      'Usage: node backtest/decision/replay.mjs decision-packet.json',
    )
  }
  const packet = JSON.parse(fs.readFileSync(input, 'utf8'))
  process.stdout.write(
    `${JSON.stringify(replayDecisionPacket(packet).result, null, 2)}\n`,
  )
}
