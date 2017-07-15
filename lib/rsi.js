module.exports = function container (get, set, clear) {
  return function rsi (s, key, length) {
    if (s.lookback.length >= length) {
      var avgGain = s.lookback[0][key + '_avg_gain']
      var avgLoss = s.lookback[0][key + '_avg_loss']
      if (typeof avgGain === 'undefined') {
        var gainSum = 0
        var lossSum = 0
        var lastClose
        s.lookback.slice(0, length).forEach(function (period) {
          if (lastClose) {
            if (period.close > lastClose) {
              gainSum += period.close - lastClose
            } else {
              lossSum += lastClose - period.close
            }
          }
          lastClose = period.close
        })
        s.period[key + '_avg_gain'] = gainSum / length
        s.period[key + '_avg_loss'] = lossSum / length
      } else {
        var currentGain = s.period.close - s.lookback[0].close
        s.period[key + '_avg_gain'] = ((avgGain * (length - 1)) + (currentGain > 0 ? currentGain : 0)) / length
        var currentLoss = s.lookback[0].close - s.period.close
        s.period[key + '_avg_loss'] = ((avgLoss * (length - 1)) + (currentLoss > 0 ? currentLoss : 0)) / length
      }
      var rs = s.period[key + '_avg_gain'] / s.period[key + '_avg_loss']
      s.period[key] = Math.round(100 - (100 / (1 + rs)))
    }
  }
}
