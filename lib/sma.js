module.exports = function container (get, set, clear) {
  return function sma (s, key, length, sourceKey) {
    if (!sourceKey) sourceKey = 'close'
    if (s.lookback.length >= length) {
      let SMA = s.lookback
        .slice(0, length)
        .reduce((sum, cur) => {
          return sum + cur[sourceKey]
        }, 0)

      s.period[key] = SMA / length
    }
  }
}
