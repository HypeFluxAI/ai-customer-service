/**
 * Operational context — injects real-time machine availability into AI suggestions
 *
 * Queries test1 DB every 5 minutes for machine stats:
 * - Total whitelisted machines (rent_mac_info)
 * - Currently rented (device.stake_rented=1 OR active rent_order_info)
 * - Available by GPU model
 */

const mongoose = require('mongoose')

const TEST1_URI = process.env.TEST1_MONGO_URI ||
  'mongodb://deeplink:DeepLinkGlobal2023@122.99.183.50:31017,122.99.183.51:31018,122.99.183.52:31019/test1?replicaSet=deeplink'

let conn = null
let summary = null
let initialized = false
let refreshTimer = null

async function getConnection() {
  if (conn && conn.readyState === 1) return conn
  conn = mongoose.createConnection(TEST1_URI, {
    connectTimeoutMS: 10000,
    socketTimeoutMS: 10000,
    maxPoolSize: 2,
  })
  await conn.asPromise()
  console.log('[OpContext] connected to test1 DB')
  return conn
}

/**
 * Check if current time falls in any scheduled unavailable window
 * Data format: { start_day: 0-6, start_time: "HH:mm", end_day: 0-6, end_time: "HH:mm" }
 */
function isInUnavailableWindow(schedules) {
  if (!schedules || !schedules.length) return false
  const now = new Date()
  const nowDay = now.getUTCDay()
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes()

  for (const s of schedules) {
    if (s.start_day == null || !s.start_time || !s.end_time) continue
    if (s.start_day !== nowDay) continue
    const [sh, sm] = s.start_time.split(':').map(Number)
    const [eh, em] = s.end_time.split(':').map(Number)
    const startMin = sh * 60 + sm
    const endMin = eh * 60 + em
    if (nowMinutes >= startMin && nowMinutes <= endMin) return true
  }
  return false
}

async function fetchStats() {
  const c = await getConnection()
  const db = c.db

  // Get whitelisted machines (same filter as getGpuList: exclude monthly_zone)
  const rentMacInfo = await db.collection('rent_mac_info')
    .find(
      { monthly_zone: { $ne: true } },
      { projection: { machine_id: 1, device_id: 1, can_rent: 1, scheduled_unavailable: 1, 'machineInfo.gpu_type': 1 } }
    )
    .toArray()

  const totalWhitelisted = rentMacInfo.length

  // Build lookup maps
  const gpuByMid = new Map()
  const rmiByDeviceId = new Map()
  for (const m of rentMacInfo) {
    gpuByMid.set(m.machine_id, m.machineInfo?.gpu_type || 'Unknown')
    if (m.device_id) rmiByDeviceId.set(m.device_id, m)
  }

  // Query device collection for online + rented status
  const deviceIds = rentMacInfo.map(m => m.device_id).filter(Boolean)
  const devices = await db.collection('device')
    .find(
      { device_id: { $in: deviceIds } },
      { projection: { device_id: 1, machine_id: 1, online: 1, stake_rented: 1 } }
    )
    .toArray()

  // Check active rental orders (device.stake_rented can be stale/inconsistent)
  const activeOrders = await db.collection('rent_order_info')
    .find(
      { device_id: { $in: deviceIds }, rent_status: { $in: [1, 2] } },
      { projection: { device_id: 1 } }
    )
    .toArray()
  const activeOrderDeviceIds = new Set(activeOrders.map(o => o.device_id?.toString()))

  let totalRented = 0
  let totalAvailable = 0
  const gpuAvail = {}

  for (const d of devices) {
    const rmi = rmiByDeviceId.get(d.device_id)
    if (!rmi) continue

    const isRented = d.stake_rented === 1 || activeOrderDeviceIds.has(d.device_id?.toString())
    if (isRented) {
      totalRented++
      continue
    }

    // Available = can_rent + online + not rented + not in scheduled window
    if (rmi.can_rent && d.online &&
        !isInUnavailableWindow(rmi.scheduled_unavailable)) {
      totalAvailable++
      const gpu = simplifyGpuName(gpuByMid.get(d.machine_id || rmi.machine_id) || 'Unknown')
      gpuAvail[gpu] = (gpuAvail[gpu] || 0) + 1
    }
  }

  const utilization = totalWhitelisted > 0 ? Math.round(totalRented / totalWhitelisted * 100) : 0

  // Build summary text
  const gpuList = Object.entries(gpuAvail)
    .sort((a, b) => b[1] - a[1])
    .map(([gpu, count]) => `${gpu} ${count}대`)
    .join(', ')

  if (totalAvailable === 0) {
    summary = `현재 총 ${totalWhitelisted}대 중 ${totalRented}대 임대 중 (${utilization}%). 현재 이용 가능한 기기 없음 — "바로 이용 가능" 등 확정 표현 절대 금지`
  } else {
    summary = `현재 총 ${totalWhitelisted}대 중 ${totalRented}대 임대 중 (${utilization}%). 이용 가능 기기 ${totalAvailable}대${gpuList ? ` (${gpuList})` : ''}`
  }
  console.log(`[OpContext] ${summary}`)
}

function simplifyGpuName(name) {
  if (!name) return 'Unknown'
  // Extract GPU model: "NVIDIA GeForce RTX 4060" → "RTX4060"
  const match = name.match(/(RTX\s*)?(\d{4}\s*(Ti)?)/i)
  return match ? match[0].replace(/\s+/g, '') : name.substring(0, 20)
}

async function initOperationalContext() {
  try {
    await fetchStats()
    initialized = true
  } catch (err) {
    console.error('[OpContext] init error:', err.message)
  }

  // Refresh every 5 minutes
  refreshTimer = setInterval(async () => {
    try {
      await fetchStats()
    } catch (err) {
      console.error('[OpContext] refresh error:', err.message)
    }
  }, 5 * 60 * 1000)
}

function getOperationalSummary() {
  return summary
}

function isReady() {
  return initialized
}

module.exports = {
  initOperationalContext,
  getOperationalSummary,
  isReady,
}
