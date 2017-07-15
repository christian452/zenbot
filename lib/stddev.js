module.exports = function container (get, set, clear) {
  return function stddev (s, key, length, sourceKey) {
    if (typeof s.period[sourceKey] === 'number') {
      var sum = s.period[sourceKey]
      var sumLen = 1
      for (let idx = 0; idx < length; idx++) {
        if (typeof s.lookback[idx][sourceKey] === 'number') {
          sum += s.lookback[idx][sourceKey]
          sumLen++
        } else {
          break
        }
      }
      var avg = sum / sumLen
      var varSum = 0
      for (let idx = 0; idx < sumLen - 1; idx++) {
        varSum += Math.pow(s.lookback[idx][sourceKey] - avg, 2)
      }
      var variance = varSum / sumLen
      s.period[key] = Math.sqrt(variance)
    }
  }
}
