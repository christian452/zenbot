#!/usr/bin/env node

/* Zenbot 4.04 Backtester v0.2
 * Ali Anari <ali@anari.io>
 * 05/30/2017
 *
 * Usage: Pass in the same parameters as you would to "zenbot sim", EXCEPT for:
 * EMA Parameters: "trend_ema", "neutral_rate"
 * RSI Parameters: "oversold_rsi", "oversold_rsi_periods"
 *
 * Example: ./backtester.js gdax.ETH-USD --days=10 --currency_capital=5
*/

const shell = require('shelljs')
const parallel = require('run-parallel-limit')
const json2csv = require('json2csv')
const roundp = require('round-precision')
const fs = require('fs')

const VERSION = 'Zenbot 4.04 Backtester v0.2'

const PARALLEL_LIMIT = require('os').cpus().length

const TREND_EMA_MIN = 20
const TREND_EMA_MAX = 20

const OVERSOLD_RSI_MIN = 20
const OVERSOLD_RSI_MAX = 35

const OVERSOLD_RSI_PERIODS_MIN = 15
const OVERSOLD_RSI_PERIODS_MAX = 25

const NEUTRAL_RATE_MIN = 10
const NEUTRAL_RATE_MAX = 10

const NEUTRAL_RATE_AUTO = false

const countArr = []

const range = (start, end, step) => {
  if (!step) step = 1
  let r = []
  for (let i = start; i <= end; i += step) {
    r = r.concat(i)
  }
  return r
}

const product = args => {
  if (!args.length) { return [[]] }
  const prod = product(args.slice(1))
  const r = []
  args[0].forEach(function (x) {
    prod.forEach(function (p) {
      r.push([x].concat(p))
    })
  })
  return r
}

const objectProduct = obj => {
  const keys = Object.keys(obj)
  const values = keys.map(function (x) { return obj[x] })

  return product(values).map(function (p) {
    const e = {}
    keys.forEach(function (k, n) { e[k] = p[n] })
    return e
  })
}

const processOutput = output => {
  const jsonRegexp = /(\{[\s\S]*?\})\send balance/g
  const endBalRegexp = /end balance: (\d+\.\d+) \(/g
  const buyHoldRegexp = /buy hold: (\d+\.\d+) \(/g
  const vsBuyHoldRegexp = /vs. buy hold: (-?\d+\.\d+)%/g
  const wlRegexp = /win\/loss: (\d+)\/(\d+)/g
  const errRegexp = /error rate: (.*)%/g

  const output2 = output.substr(output.length - 3000)

  const rawParams = jsonRegexp.exec(output2)[1]
  const params = JSON.parse(rawParams)
  const endBalance = endBalRegexp.exec(output2)[1]
  const buyHold = buyHoldRegexp.exec(output2)[1]
  const vsBuyHold = vsBuyHoldRegexp.exec(output2)[1]
  const wlMatch = wlRegexp.exec(output2)
  const wins = parseInt(wlMatch[1])
  const losses = parseInt(wlMatch[2])
  const errorRate = errRegexp.exec(output2)[1]
  const days = parseInt(params.days)

  const roi = roundp(
    ((endBalance - params.currency_capital) / params.currency_capital) * 100,
    3
  )

  return {
    params: rawParams.replace(/[\r\n]/g, ''),
    endBalance: parseFloat(endBalance),
    buyHold: parseFloat(buyHold),
    vsBuyHold: parseFloat(vsBuyHold),
    wins: wins,
    losses: losses,
    errorRate: parseFloat(errorRate),

    // cci_srsi
    cciPeriods: params.cci_periods,
    rsiPeriods: params.rsi_periods,
    srsiPeriods: params.srsi_periods,
    srsiK: params.srsi_k,
    srsiD: params.srsi_d,
    oversoldRsi: params.oversold_rsi,
    overboughtRsi: params.overbought_rsi,
    oversoldCci: params.oversold_cci,
    overboughtCci: params.overbought_cci,
    constant: params.consant,

    // srsi_macd
    emaShortPeriod: params.ema_short_period,
    emaLongPeriod: params.ema_long_period,
    signalPeriod: params.signal_period,
    upTrendThreshold: params.up_trend_threshold,
    downTrendThreshold: params.down_trend_threshold,

    // macd
    overboughtRsiPeriods: params.overbought_rsi_periods,

    // rsi
    rsiRecover: params.rsi_recover,
    rsiDrop: params.rsi_drop,
    rsiDivsor: params.rsi_divisor,

    // sar
    sarAf: params.sar_af,
    sarMaxAf: params.sar_max_af,

    // speed
    baselinePeriods: params.baseline_periods,
    triggerFactor: params.trigger_factor,

    // trend_ema
    trendEma: params.trend_ema,
    neutralRate: params.neutral_rate,
    oversoldRsiPeriods: params.oversold_rsi_periods,

    days: days,
    period: params.period,
    min_periods: params.min_periods,
    roi: roi,
    wlRatio: losses > 0 ? roundp(wins / losses, 3) : 'Infinity',
    frequency: roundp((wins + losses) / days, 3)
  }
}

const strategies = {
  cci_srsi: objectProduct({
    period: ['20m'],
    min_periods: [52, 200],
    rsi_periods: [14, 20],
    srsi_periods: [14, 20],
    srsi_k: [3, 9],
    srsi_d: [3, 9],
    oversold_rsi: [22],
    overbought_rsi: [85],
    oversold_cci: [-90],
    overbought_cci: [140],
    constant: [0.015]
  }),
  srsi_macd: objectProduct({
    period: ['30m'],
    min_periods: [52, 200],
    rsi_periods: [14, 20],
    srsi_periods: [14, 20],
    srsi_k: [3, 9],
    srsi_d: [3, 9],
    oversold_rsi: [18],
    overbought_rsi: [82],
    ema_short_period: [12, 24],
    ema_long_period: [26, 200],
    signal_period: [9, 14],
    up_trend_threshold: [0],
    down_trend_threshold: [0]
  }),
  macd: objectProduct({
    period: ['1h'],
    min_periods: [52],
    ema_short_period: range(10, 15),
    ema_long_period: range(20, 30),
    signal_period: range(9, 9),
    up_trend_threshold: range(0, 0),
    down_trend_threshold: range(0, 0),
    overbought_rsi_periods: range(15, 25),
    overbought_rsi: range(70, 70)
  }),
  rsi: objectProduct({
    period: ['2m'],
    min_periods: [52],
    rsi_periods: range(10, 30),
    oversold_rsi: range(20, 35),
    overbought_rsi: range(82, 82),
    rsi_recover: range(3, 3),
    rsi_drop: range(0, 0),
    rsi_divisor: range(2, 2)
  }),
  sar: objectProduct({
    period: ['2m'],
    min_periods: [52],
    sar_af: range(0.01, 0.055, 0.005),
    sar_max_af: range(0.1, 0.55, 0.05)
  }),
  speed: objectProduct({
    period: ['1m'],
    min_periods: [52],
    baseline_periods: range(1000, 5000, 200),
    trigger_factor: range(1.0, 2.0, 0.1)
  }),
  trend_ema: objectProduct({
    period: ['2m'],
    min_periods: [52],
    trend_ema: range(TREND_EMA_MIN, TREND_EMA_MAX),
    neutral_rate: (NEUTRAL_RATE_AUTO ? new Array('auto') : []).concat(range(NEUTRAL_RATE_MIN, NEUTRAL_RATE_MAX).map(r => r / 100)),
    oversold_rsi_periods: range(OVERSOLD_RSI_PERIODS_MIN, OVERSOLD_RSI_PERIODS_MAX),
    oversold_rsi: range(OVERSOLD_RSI_MIN, OVERSOLD_RSI_MAX)
  })
}

const args = process.argv
args.shift()
args.shift()

const exchangeSelector = args[0]
if (!exchangeSelector) {
  throw new Error('Please select an exchange selector to run simulations for.')
}

let strategyName = 'trend_ema'
if (args.indexOf('--strategy') !== -1) {
  strategyName = args[args.indexOf('--strategy') + 1]
}

// const tasks = strategies_tend_ema.map(strategy => {
let tasks = []
if (strategyName === 'all') {
  for (const strategy in strategies) {
    tasks = tasks.concat(getTasksByStrategy(strategy))
  }
} else {
  tasks = tasks.concat(getTasksByStrategy(strategyName))
}

console.log(`\n--==${VERSION}==--`)
console.log(new Date().toUTCString())
console.log(`\nBacktesting [${tasks.length}] iterations for strategy ${strategyName}...\n`)

parallel(tasks, PARALLEL_LIMIT, (err, results) => {
  if (err) throw err
  console.log('\nBacktesting complete, saving results...')
  results = results.filter(function (r) {
    return !!r
  })
  results.sort((a, b) => (a.roi < b.roi) ? 1 : ((b.roi < a.roi) ? -1 : 0))
  const fileName = `backtesting_${strategyName}_${Math.round(+new Date() / 1000)}.csv`
  const fieldsGeneral = ['roi', 'vsBuyHold', 'errorRate', 'wlRatio', 'frequency', 'endBalance', 'buyHold', 'wins', 'losses', 'period', 'min_periods', 'days']
  const fieldNamesGeneral = ['ROI (%)', 'VS Buy Hold (%)', 'Error Rate (%)', 'Win/Loss Ratio', '# Trades/Day', 'Ending Balance ($)', 'Buy Hold ($)', '# Wins', '# Losses', 'Period', 'Min Periods', '# Days']
  /* const fields = {
    cci_srsi: filedsGeneral.concat(['cciPeriods', 'rsiPeriods', 'srsiPeriods', 'srsiK', 'srsiD', 'oversoldRsi', 'overboughtRsi', 'oversoldCci', 'overboughtCci', 'Constant', 'params']),
    srsi_macd: filedsGeneral.concat(['rsiPeriods', 'srsiPeriods', 'srsiK', 'srsiD', 'oversoldRsi', 'overboughtRsi', 'emaShortPeriod', 'emaLongPeriod', 'signalPeriod', 'upTrendThreshold', 'downTrendThreshold', 'params']),
    macd: filedsGeneral.concat(['emaShortPeriod', 'emaLongPeriod', 'signalPeriod', 'upTrendThreshold', 'downTrendThreshold', 'overboughtRsiPeriods', 'overboughtRsi', 'params']),
    rsi: filedsGeneral.concat(['rsiPeriods', 'oversoldRsi', 'overboughtRsi', 'rsiRecover', 'rsiDrop', 'rsiDivsor', 'params']),
    sar: filedsGeneral.concat(['sarAf', 'sarMaxAf', 'params']),
    speed: filedsGeneral.concat(['baselinePeriods', 'triggerFactor', 'params']),
    trend_ema: filedsGeneral.concat(['trendEma', 'neutralRate', 'oversoldRsiPeriods', 'oversoldRsi', 'params'])
  }
  const fieldNames = {
    cci_srsi: filedNamesGeneral.concat(['CCI Periods', 'RSI Periods', 'SRSI Periods', 'SRSI K', 'SRSI D', 'Oversold RSI', 'Overbought RSI', 'Oversold CCI', 'Overbought CCI', 'Constant', 'Full Parameters']),
    srsi_macd: filedNamesGeneral.concat(['RSI Periods', 'SRSI Periods', 'SRSI K', 'SRSI D', 'Oversold RSI', 'Overbought RSI', 'EMA Short Period', 'EMA Long Period', 'Signal Period', 'Up Trend Threshold', 'Down Trend Threshold', 'Full Parameters']),
    macd: filedNamesGeneral.concat(['EMA Short Period', 'EMA Long Period', 'Signal Period', 'Up Trend Threshold', 'Down Trend Threshold', 'Overbought Rsi Periods', 'Overbought Rsi', 'Full Parameters']),
    rsi: filedNamesGeneral.concat(['RSI Periods', 'Oversold RSI', 'Overbought RSI', 'RSI Recover', 'RSI Drop', 'RSI Divisor', 'Full Parameters']),
    sar: filedNamesGeneral.concat(['SAR AF', 'SAR MAX AF', 'Full Parameters']),
    speed: filedNamesGeneral.concat(['Baseline Periods', 'Trigger Factor', 'Full Parameters']),
    trend_ema: filedNamesGeneral.concat(['Trend EMA', 'Neutral Rate', 'Oversold RSI Periods', 'Oversold RSI', 'Full Parameters'])
  } */
  const csv = json2csv({
    data: results,
    fields: fieldsGeneral, // fields[strategyName],
    fieldNames: fieldNamesGeneral // fieldNames[strategyName]
  })

  fs.writeFile(fileName, csv, err => {
    if (err) throw err
    console.log(`\nResults successfully saved to ${fileName}!\n`)
  })
})

function getTasksByStrategy (strategyId) {
  return strategies[strategyId].map(strategy => {
    return cb => {
      runCommand(strategy, strategyId, cb)
    }
  })
}

function runCommand (strategy, strategyId, cb) {
  countArr.push(1)
  const strategyArgs = {
    cci_srsi: `--cci_periods=${strategy.rsi_periods} --rsi_periods=${strategy.srsi_periods} --srsi_periods=${strategy.srsi_periods} --srsi_k=${strategy.srsi_k} --srsi_d=${strategy.srsi_d} --oversold_rsi=${strategy.oversold_rsi} --overbought_rsi=${strategy.overbought_rsi} --oversold_cci=${strategy.oversold_cci} --overbought_cci=${strategy.overbought_cci} --constant=${strategy.constant}`,
    srsi_macd: `--rsi_periods=${strategy.rsi_periods} --srsi_periods=${strategy.srsi_periods} --srsi_k=${strategy.srsi_k} --srsi_d=${strategy.srsi_d} --oversold_rsi=${strategy.oversold_rsi} --overbought_rsi=${strategy.overbought_rsi} --ema_short_period=${strategy.ema_short_period} --ema_long_period=${strategy.ema_long_period} --signal_period=${strategy.signal_period} --up_trend_threshold=${strategy.up_trend_threshold} --down_trend_threshold=${strategy.down_trend_threshold}`,
    macd: `--ema_short_period=${strategy.ema_short_period} --ema_long_period=${strategy.ema_long_period} --signal_period=${strategy.signal_period} --up_trend_threshold=${strategy.up_trend_threshold} --down_trend_threshold=${strategy.down_trend_threshold} --overbought_rsi_periods=${strategy.overbought_rsi_periods} --overbought_rsi=${strategy.overbought_rsi}`,
    rsi: `--rsi_periods=${strategy.rsi_periods} --oversold_rsi=${strategy.oversold_rsi} --overbought_rsi=${strategy.overbought_rsi} --rsi_recover=${strategy.rsi_recover} --rsi_drop=${strategy.rsi_drop} --rsi_divisor=${strategy.rsi_divisor}`,
    sar: `--sar_af=${strategy.sar_af} --sar_max_af=${strategy.sar_max_af}`,
    speed: `--baseline_periods=${strategy.baseline_periods} --trigger_factor=${strategy.trigger_factor}`,
    trend_ema: `--trend_ema=${strategy.trend_ema} --oversold_rsi=${strategy.oversold_rsi} --oversold_rsi_periods=${strategy.oversold_rsi_periods} --neutral_rate=${strategy.neutral_rate}`
  }
  const command = `zenbot sim ${exchangeSelector} --strategy ${strategyId} ${strategyArgs[strategyId]} --period=${strategy.period}  --min_periods=${strategy.min_periods}`
  console.log(`[ ${countArr.length}/${strategies[strategyId].length} ] ${command}`)

  shell.exec(command, {silent: true, async: true}, (code, stdout, stderr) => {
    if (code) {
      console.error(command)
      console.error(stderr)
      return cb(null, null)
    }
    cb(null, processOutput(stdout))
  })
}
