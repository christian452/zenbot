const tb = require('timebucket')
const moment = require('moment')
const z = require('zero-fill')
const n = require('numbro')
const series = require('run-series')
const abbreviate = require('number-abbreviate')
const readline = require('readline')

const niceErrors = new RegExp(/(slippage protection|loss protection)/)

module.exports = function container (get, set, clear) {
  const c = get('conf')
  return function (s) {
    const so = s.options
    s.selector = get('lib.normalize-selector')(so.selector)
    const selectorParts = s.selector.split('.')
    s.exchange = get('exchanges.' + selectorParts[0])
    s.product_id = selectorParts[1]
    s.asset = s.product_id.split('-')[0]
    s.currency = s.product_id.split('-')[1]
    const products = s.exchange.getProducts()
    products.forEach(function (product) {
      if (product.asset === s.asset && product.currency === s.currency) {
        s.product = product
      }
    })
    if (!s.product) {
      console.error('error: could not find product "' + s.product_id + '"')
      process.exit(1)
    }
    if (so.mode === 'sim' || so.mode === 'paper') {
      s.balance = {asset: so.asset_capital, currency: so.currency_capital}
    } else {
      s.balance = {asset: 0, currency: 0}
    }

    function memDump () {
      if (!so.debug) return
      const sCopy = JSON.parse(JSON.stringify(s))
      delete sCopy.options.mongo
      delete sCopy.lookback
      get('exchanges.list').forEach(function (x) {
        delete sCopy.options[x.name]
      })
      console.error(sCopy)
    }

    s.ctx = {
      option: function (name, desc, type, def) {
        if (typeof so[name] === 'undefined') {
          so[name] = def
        }
      }
    }

    let assetColWidth = 0
    let currencyColWidth = 0
    s.lookback = []
    s.day_count = 1
    s.my_trades = []
    s.vol_since_last_blink = 0
    if (so.strategy) {
      s.strategy = get('strategies.' + so.strategy)
      if (s.strategy.getOptions) {
        s.strategy.getOptions.call(s.ctx)
      }
    }

    function msg (str) {
      if (so.debug) {
        console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - ' + str)
      }
    }

    function fa (amt) {
      return n(amt).format('0.00000000') + ' ' + s.asset
    }

    function isFiat () {
      return !s.currency.match(/^BTC|ETH|XMR|USD|USDT$/)
    }

    let maxFcWidth = 0

    function fc (amt, omitCurrency, colorTrick, doPad) {
      let str
      if (isFiat()) {
        str = n(amt).format('0.00')
      } else {
        str = n(amt).format('0.00000000')
        if (str.split('.').length >= 2) { if (str.split('.')[1].length === 7) str += '0' }
      }
      if (doPad) {
        maxFcWidth = Math.max(maxFcWidth, str.length)
        str = ' '.repeat(maxFcWidth - str.length) + str
      }
      if (colorTrick) {
        str = str
          .replace(/^(.*\.)(0*)(.*?)(0*)$/, function (_, m, m2, m3, m4) {
            return m.cyan + m2.grey + m3.yellow + m4.grey
          })
      }
      return str + (omitCurrency ? '' : ' ' + s.currency)
    }

    function pct (ratio) {
      return (ratio >= 0 ? '+' : '') + n(ratio).format('0.0%')
    }

    function initBuffer (trade) {
      const d = tb(trade.time).resize(so.period)
      s.period = {
        period_id: d.toString(),
        size: so.period,
        time: d.toMilliseconds(),
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: 0,
        close_time: null
      }
    }

    function onTrade (trade) {
      s.period.high = Math.max(trade.price, s.period.high)
      s.period.low = Math.min(trade.price, s.period.low)
      s.period.close = trade.price
      s.period.volume += trade.size
      s.period.close_time = trade.time
      s.strategy.calculate(s)
      s.vol_since_last_blink += trade.size
    }

    function executeStop (doSellStop) {
      let stopSignal
      if (s.my_trades.length) {
        const lastTrade = s.my_trades[s.my_trades.length - 1]
        s.last_trade_worth = lastTrade.type === 'buy' ? (s.period.close - lastTrade.price) / lastTrade.price : (lastTrade.price - s.period.close) / lastTrade.price
        if (!s.acted_on_stop) {
          if (lastTrade.type === 'buy') {
            if (doSellStop && s.sell_stop && s.period.close < s.sell_stop) {
              stopSignal = 'sell'
              console.log(('\nsell stop triggered at ' + pct(s.last_trade_worth) + ' trade worth\n').red)
            } else if (so.profit_stop_enable_pct && s.last_trade_worth >= (so.profit_stop_enable_pct / 100)) {
              s.profit_stop_high = Math.max(s.profit_stop_high || s.period.close, s.period.close)
              s.profit_stop = s.profit_stop_high - (s.profit_stop_high * (so.profit_stop_pct / 100))
            }
            if (s.profit_stop && s.period.close < s.profit_stop && s.last_trade_worth > 0) {
              stopSignal = 'sell'
              console.log(('\nprofit stop triggered at ' + pct(s.last_trade_worth) + ' trade worth\n').green)
            }
          } else {
            if (s.buy_stop && s.period.close > s.buy_stop) {
              stopSignal = 'buy'
              console.log(('\nbuy stop triggered at ' + pct(s.last_trade_worth) + ' trade worth\n').red)
            }
          }
        }
      }
      if (stopSignal) {
        s.signal = stopSignal
        s.acted_on_stop = true
      }
    }

    function syncBalance (cb) {
      if (so.mode !== 'live') {
        return cb()
      }
      s.exchange.getBalance({currency: s.currency, asset: s.asset}, function (err, balance) {
        if (err) return cb(err)
        s.balance = balance
        if (!s.start_capital) {
          s.exchange.getQuote({product_id: s.product_id}, function (err, quote) {
            if (err) return cb(err)
            s.start_price = n(quote.ask).value()
            s.start_capital = n(s.balance.currency).add(n(s.balance.asset).multiply(quote.ask)).value()
            cb()
          })
        } else cb()
      })
    }

    function placeOrder (type, opts, cb) {
      if (!s[type + '_order']) {
        s[type + '_order'] = {
          price: opts.price,
          size: opts.size,
          orig_size: opts.size,
          remaining_size: opts.size,
          orig_price: opts.price,
          order_type: opts.is_taker ? 'taker' : so.order_type
        }
      }
      const order = s[type + '_order']
      order.price = opts.price
      order.size = opts.size
      if (so.mode !== 'live') {
        if (!order.orig_time) order.orig_time = s.period.close_time
        order.time = s.period.close_time
        return cb(null, order)
      } else {
        order.product_id = s.product_id
        order.post_only = true
        msg('placing ' + type + ' order...')
        const orderCopy = JSON.parse(JSON.stringify(order))
        s.exchange[type](orderCopy, function (err, apiOrder) {
          if (err) return cb(err)
          s.api_order = apiOrder
          if (apiOrder.status === 'rejected') {
            if (apiOrder.reject_reason === 'post only') {
              // trigger immediate price adjustment and re-order
              msg('post-only ' + type + ' failed, re-ordering')
              return cb(null, null)
            } else if (apiOrder.reject_reason === 'balance') {
              // treat as a no-op.
              msg('not enough balance for ' + type + ', aborting')
              return cb(null, false)
            }
            const err = new Error('order rejected')
            err.order = apiOrder
            return cb(err)
          }
          msg(type + ' order placed at ' + fc(order.price))
          order.order_id = apiOrder.id
          if (!order.time) {
            order.orig_time = new Date(apiOrder.created_at).getTime()
          }
          order.time = new Date(apiOrder.created_at).getTime()
          order.local_time = new Date().getTime()
          order.status = apiOrder.status
          msg('Created ' + order.status + ' ' + type + ' order: ' + fa(order.size) + ' at ' + fc(order.price) + ' (total ' + fc(n(order.price).multiply(order.size)) + ')\n')
          function cancelOrder (doReorder) {
            msg('cancelling order')
            s.exchange.cancelOrder({order_id: order.order_id}, function (err) {
              if (err) throw err
              function checkHold () {
                s.exchange.getOrder({order_id: order.order_id, product_id: s.product_id}, function (err, apiOrder) {
                  if (err) throw err
                  if (apiOrder) {
                    s.api_order = apiOrder
                    if (apiOrder.filled_size) {
                      order.remaining_size = n(order.size).subtract(apiOrder.filled_size).format('0.00000000')
                    }
                  }
                  syncBalance(function () {
                    if (!s.balance.asset_hold && !s.balance.currency_hold) {
                      cb(null, doReorder ? null : false)
                    }

                    msg(`Looks like we have asserts on hold. Our current balance is ${JSON.stringify(s.balance)}`)
                    msg(`Canceling order response ${JSON.stringify(apiOrder)}`)

                    let onHold
                    if (type === 'buy') onHold = n(s.balance.currency).subtract(s.balance.currency_hold || 0).value() < n(order.price).multiply(order.remaining_size).value()
                    else onHold = n(s.balance.asset).subtract(s.balance.asset_hold || 0).value() < n(order.remaining_size).value()
                    if (onHold) {
                      // wait a bit for settlement
                      msg('funds on hold after cancel, waiting 5s')
                      setTimeout(checkHold, c.wait_for_settlement)
                    } else {
                      cb(null, doReorder ? null : false)
                    }
                  })
                })
              }

              checkHold()
            })
          }

          function checkOrder () {
            if (!s[type + '_order']) {
              // signal switched, stop checking order
              msg('signal switched during ' + type + ', aborting')
              return cancelOrder(false)
            }
            s.exchange.getOrder({order_id: order.order_id, product_id: s.product_id}, function (err, apiOrder) {
              if (err) return cb(err)
              s.api_order = apiOrder
              order.status = apiOrder.status
              msg('order status: ' + order.status)
              if (apiOrder.status === 'done') {
                order.time = new Date(apiOrder.done_at).getTime()
                executeOrder(order)
                return syncBalance(function () {
                  cb(null, order)
                })
              }
              if (order.status === 'rejected' && order.reject_reason === 'post only') {
                msg('post-only ' + type + ' failed, re-ordering')
                return cancelOrder(true)
              }
              if (new Date().getTime() - order.local_time >= so.order_adjust_time) {
                getQuote(function (err, quote) {
                  if (err) {
                    err.desc = 'could not execute ' + type + ': error fetching quote'
                    return cb(err)
                  }
                  let markedPrice
                  if (type === 'buy') {
                    markedPrice = n(quote.bid).subtract(n(quote.bid).multiply(so.markup_pct / 100)).format(s.product.increment, Math.floor)
                    if (n(order.price).value() < markedPrice) {
                      msg(markedPrice + ' vs our ' + order.price)
                      cancelOrder(true)
                    } else {
                      order.local_time = new Date().getTime()
                      setTimeout(checkOrder, so.order_poll_time)
                    }
                  } else {
                    markedPrice = n(quote.ask).add(n(quote.ask).multiply(so.markup_pct / 100)).format(s.product.increment, Math.ceil)
                    if (n(order.price).value() > markedPrice) {
                      msg(markedPrice + ' vs our ' + order.price)
                      cancelOrder(true)
                    } else {
                      order.local_time = new Date().getTime()
                      setTimeout(checkOrder, so.order_poll_time)
                    }
                  }
                })
              } else {
                setTimeout(checkOrder, so.order_poll_time)
              }
            })
          }

          setTimeout(checkOrder, so.order_poll_time)
        })
      }
    }

    function getQuote (cb) {
      if (so.mode === 'sim') {
        return cb(null, {
          bid: s.period.close,
          ask: s.period.close
        })
      } else {
        s.exchange.getQuote({product_id: s.product_id}, function (err, quote) {
          if (err) return cb(err)
          s.quote = quote
          cb(null, quote)
        })
      }
    }

    // if s.signal
    // 1. sync balance
    // 2. get quote
    // 3. calculate size/price
    // 4. validate size against min/max sizes
    // 5. cancel old orders
    // 6. place new order
    // 7. record order ID and start poll timer
    // 8. if not filled after timer, repeat process
    // 9. if filled, record order stats
    function executeSignal (signal, _cb, size, isReorder, isTaker) {
      msg(`\n Executing ${signal} signal`)
      let price
      delete s[(signal === 'buy' ? 'sell' : 'buy') + '_order']
      s.last_signal = signal
      if (!isReorder && s[signal + '_order']) {
        if (isTaker) s[signal + '_order'].order_type = 'taker'
        // order already placed
        _cb && _cb(null, null)
        return
      }
      s.acted_on_trend = true
      const cb = function (err, order) {
        if (!order) {
          if (signal === 'buy') delete s.buy_order
          else delete s.sell_order
        }
        if (err) {
          if (_cb) {
            _cb(err)
          } else if (err.message.match(niceErrors)) {
            console.error((err.message + ': ' + err.desc).red)
          } else {
            memDump()
            console.error('\n')
            console.error(err)
            console.error('\n')
          }
        } else if (_cb) {
          _cb(null, order)
        }
      }
      syncBalance(function (err) {
        msg(`\n Syncing balance`)
        if (err) {
          msg('error getting balance')
        }

        getQuote(function (err, quote) {
          msg(`\n Getting quote`)
          if (err) {
            err.desc = 'could not execute ' + signal + ': error fetching quote'
            return cb(err)
          }
          if (signal === 'buy') {
            price = n(quote.bid).subtract(n(quote.bid).multiply(so.markup_pct / 100)).format(s.product.increment, Math.floor)
            if (!size) {
              size = n(s.balance.currency).multiply(so.buy_pct).divide(100).divide(price).format('0.00000000')
            }

            msg(`Checking if we can buy size: ${size} of ${JSON.stringify(s.product)} with price: ${price}`)
            if (canTransact(s.product, size, price)) {
              if (s.product.max_size && Number(size) > Number(s.product.max_size)) {
                size = s.product.max_size
              }
              if (s.buy_order && so.max_slippage_pct) {
                const slippage = n(price).subtract(s.buy_order.orig_price).divide(s.buy_order.orig_price).multiply(100).value()
                if (so.max_slippage_pct && slippage > so.max_slippage_pct) {
                  const err = new Error('slippage protection')
                  err.desc = 'refusing to buy at ' + fc(price) + ', slippage of ' + pct(slippage / 100)
                  return cb(err)
                }
              }
              if (n(s.balance.currency).subtract(s.balance.currency_hold || 0).value() < n(price).multiply(size).value()) {
                msg('buy delayed: ' + pct(n(s.balance.currency_hold || 0).divide(s.balance.currency).value()) + ' of funds (' + fc(s.balance.currency_hold) + ') on hold')
                return setTimeout(function () {
                  if (s.last_signal === signal) {
                    executeSignal(signal, cb, size, true)
                  }
                }, c.wait_for_settlement)
              } else {
                msg('Placing buy order at ' + fc(price))
                doOrder()
              }
            } else {
              console.error('\n Could not place buy order')
              console.error('Size: ' + size)
              console.error('Price: ' + price)
              console.error('Product: ', s.product)
              cb(null, null)
            }
          } else if (signal === 'sell') {
            price = n(quote.ask).add(n(quote.ask).multiply(so.markup_pct / 100)).format(s.product.increment, Math.ceil)
            if (!size) {
              size = n(s.balance.asset).multiply(so.sell_pct / 100).format('0.00000000')
            }
            msg(`Checking if we can sell size: ${size} of ${JSON.stringify(s.product)} with price: ${price}`)
            if (canTransact(s.product, size, price)) {
              if (s.product.max_size && Number(size) > Number(s.product.max_size)) {
                size = s.product.max_size
              }
              const sellLoss = s.last_buy_price ? (Number(price) - s.last_buy_price) / s.last_buy_price * -100 : null
              if (so.max_sell_loss_pct && sellLoss > so.max_sell_loss_pct) {
                const err = new Error('loss protection')
                err.desc = 'refusing to sell at ' + fc(price) + ', sell loss of ' + pct(sellLoss / 100)
                return cb(err)
              } else {
                if (s.sell_order && so.max_slippage_pct) {
                  const slippage = n(s.sell_order.orig_price).subtract(price).divide(price).multiply(100).value()
                  if (slippage > so.max_slippage_pct) {
                    const err = new Error('slippage protection')
                    err.desc = 'refusing to sell at ' + fc(price) + ', slippage of ' + pct(slippage / 100)
                    return cb(err)
                  }
                }
                if (n(s.balance.asset).subtract(s.balance.asset_hold || 0).value() < n(size).value()) {
                  msg('sell delayed: ' + pct(n(s.balance.asset_hold || 0).divide(s.balance.asset).value()) + ' of funds (' + fa(s.balance.asset_hold) + ') on hold')
                  return setTimeout(function () {
                    if (s.last_signal === signal) {
                      executeSignal(signal, cb, size, true)
                    }
                  }, c.wait_for_settlement)
                } else {
                  msg('Placing sell order at ' + fc(price))
                  doOrder()
                }
              }
            } else {
              console.error('\n Could not place sell order')
              console.error('Size: ' + size)
              console.error('Price: ' + price)
              console.error('Product: ', s.product)
              cb(null, null)
            }
          }
        })
      })
      function doOrder () {
        placeOrder(signal, {
          size: size,
          price: price,
          is_taker: isTaker
        }, function (err, order) {
          if (err) {
            err.desc = 'could not execute ' + signal + ': error placing order'
            return cb(err)
          }
          if (!order) {
            if (order === false) {
              // not enough balance, or signal switched.
              msg('not enough balance, or signal switched, cancel ' + signal)
              return cb(null, null)
            }
            if (s.last_signal !== signal) {
              // order timed out but a new signal is taking its place
              msg('signal switched, cancel ' + signal)
              return cb(null, null)
            }
            // order timed out and needs adjusting
            msg(signal + ' order timed out, adjusting price')
            const remainingSize = s[signal + '_order'] ? s[signal + '_order'].remaining_size : size
            if (remainingSize !== size) {
              msg('remaining size: ' + remainingSize)
            }
            return executeSignal(signal, _cb, remainingSize, true)
          }
          cb(null, order)
        })
      }
    }

    function executeOrder (trade) {
      let price
      let fee = 0
      if (!so.order_type) {
        so.order_type = 'maker'
      }

      if (s.buy_order) {
        if (so.mode === 'live' || trade.price <= Number(s.buy_order.price)) {
          price = s.buy_order.price
          if (so.mode !== 'live') {
            price = n(s.buy_order.orig_price).add(n(s.buy_order.orig_price).multiply(so.avg_slippage_pct / 100)).format('0.00000000')
            s.balance.asset = n(s.balance.asset).add(s.buy_order.size).format('0.00000000')
            const total = n(price).multiply(s.buy_order.size)
            s.balance.currency = n(s.balance.currency).subtract(total).format('0.00000000')
            if (so.order_type === 'maker') {
              if (s.exchange.makerFee) {
                fee = n(s.buy_order.size).multiply(s.exchange.makerFee / 100).value()
                s.balance.asset = n(s.balance.asset).subtract(fee).format('0.00000000')
              }
            }
            if (so.order_type === 'taker') {
              if (s.exchange.takerFee) {
                fee = n(s.buy_order.size).multiply(s.exchange.takerFee / 100).value()
                s.balance.asset = n(s.balance.asset).subtract(fee).format('0.00000000')
              }
            }
          }
          s.action = 'bought'
          const myTrade = {
            order_id: trade.order_id,
            time: trade.time,
            execution_time: trade.time - s.buy_order.orig_time,
            slippage: n(price).subtract(s.buy_order.orig_price).divide(s.buy_order.orig_price).value(),
            type: 'buy',
            size: s.buy_order.orig_size,
            fee: fee,
            price: price,
            order_type: so.order_type
          }
          s.my_trades.push(myTrade)
          if (so.stats) {
            console.log(('\nbuy order completed at ' + moment(trade.time).format('YYYY-MM-DD HH:mm:ss') + ':\n\n' + fa(myTrade.size) + ' at ' + fc(myTrade.price) + '\ntotal ' + fc(myTrade.size * myTrade.price) + '\n' + n(myTrade.slippage).format('0.0000%') + ' slippage (orig. price ' + fc(s.buy_order.orig_price) + ')\nexecution: ' + moment.duration(myTrade.execution_time).humanize() + '\n').cyan)
          }
          s.last_buy_price = myTrade.price
          delete s.buy_order
          delete s.buy_stop
          delete s.sell_stop
          if (!s.acted_on_stop && so.sell_stop_pct) {
            s.sell_stop = n(price).subtract(n(price).multiply(so.sell_stop_pct / 100)).value()
          }
          delete s.profit_stop
          delete s.profit_stop_high
        }
      } else if (s.sell_order) {
        if (so.mode === 'live' || trade.price >= s.sell_order.price) {
          price = s.sell_order.price
          if (so.mode !== 'live') {
            price = n(s.sell_order.orig_price).subtract(n(s.sell_order.orig_price).multiply(so.avg_slippage_pct / 100)).format('0.00000000')
            s.balance.asset = n(s.balance.asset).subtract(s.sell_order.size).value()
            const total = n(price).multiply(s.sell_order.size)
            s.balance.currency = n(s.balance.currency).add(total).value()
            if (so.order_type === 'maker') {
              if (s.exchange.makerFee) {
                fee = n(s.sell_order.size).multiply(s.exchange.makerFee / 100).multiply(price).value()
                s.balance.currency = n(s.balance.currency).subtract(fee).format('0.00000000')
              }
            }
            if (so.order_type === 'taker') {
              if (s.exchange.takerFee) {
                fee = n(s.sell_order.size).multiply(s.exchange.takerFee / 100).multiply(price).value()
                s.balance.currency = n(s.balance.currency).subtract(fee).format('0.00000000')
              }
            }
          }
          s.action = 'sold'
          const myTrade = {
            order_id: trade.order_id,
            time: trade.time,
            execution_time: trade.time - s.sell_order.orig_time,
            slippage: n(s.sell_order.orig_price).subtract(price).divide(price).value(),
            type: 'sell',
            size: s.sell_order.orig_size,
            fee: fee,
            price: price,
            order_type: so.order_type
          }
          s.my_trades.push(myTrade)
          if (so.stats) {
            console.log(('\nsell order completed at ' + moment(trade.time).format('YYYY-MM-DD HH:mm:ss') + ':\n\n' + fa(myTrade.size) + ' at ' + fc(myTrade.price) + '\ntotal ' + fc(myTrade.size * myTrade.price) + '\n' + n(myTrade.slippage).format('0.0000%') + ' slippage (orig. price ' + fc(s.sell_order.orig_price) + ')\nexecution: ' + moment.duration(myTrade.execution_time).humanize() + '\n').cyan)
          }
          s.last_sell_price = myTrade.price
          delete s.sell_order
          delete s.buy_stop
          if (!s.acted_on_stop && so.buy_stop_pct) {
            s.buy_stop = n(price).add(n(price).multiply(so.buy_stop_pct / 100)).value()
          }
          delete s.sell_stop
          delete s.profit_stop
          delete s.profit_stop_high
        }
      }
    }

    function adjustBid (trade) {
      if (so.mode === 'live') return
      if (s.buy_order && trade.time - s.buy_order.time >= so.order_adjust_time) {
        executeSignal('buy', null, null, true)
      } else if (s.sell_order && trade.time - s.sell_order.time >= so.order_adjust_time) {
        executeSignal('sell', null, null, true)
      }
    }

    function writeReport (isProgress, blinkOff) {
      if (so.mode === 'sim' && !so.verbose) {
        isProgress = true
      } else if (isProgress && typeof blinkOff === 'undefined' && s.vol_since_last_blink) {
        s.vol_since_last_blink = 0
        setTimeout(function () {
          writeReport(true, true)
        }, 200)
        setTimeout(function () {
          writeReport(true, false)
        }, 400)
        setTimeout(function () {
          writeReport(true, true)
        }, 600)
        setTimeout(function () {
          writeReport(true, false)
        }, 800)
      }
      readline.clearLine(process.stdout)
      readline.cursorTo(process.stdout, 0)
      process.stdout.write(moment(isProgress ? s.period.close_time : tb(s.period.time).resize(so.period).add(1).toMilliseconds()).format('YYYY-MM-DD HH:mm:ss')[isProgress && !blinkOff ? 'bgBlue' : 'grey'])
      process.stdout.write('  ' + fc(s.period.close, true, true, true) + ' ' + s.product_id.grey)
      if (s.lookback[0]) {
        const diff = (s.period.close - s.lookback[0].close) / s.lookback[0].close
        process.stdout.write(z(7, pct(diff), ' ')[diff >= 0 ? 'green' : 'red'])
      } else {
        process.stdout.write(z(8, '', ' '))
      }
      let volumeDisplay = s.period.volume > 99999 ? abbreviate(s.period.volume, 2) : n(s.period.volume).format('0')
      volumeDisplay = z(8, volumeDisplay, ' ')
      if (volumeDisplay.indexOf('.') === -1) volumeDisplay = ' ' + volumeDisplay
      process.stdout.write(volumeDisplay[isProgress && blinkOff ? 'cyan' : 'grey'])
      get('lib.rsi')(s, 'rsi', so.rsi_periods)
      if (typeof s.period.rsi === 'number') {
        let half = 5
        let bar = ''
        let stars = 0
        if (s.period.rsi >= 50) {
          bar += ' '.repeat(half)
          stars = Math.min(Math.round(((s.period.rsi - 50) / 50) * half) + 1, half)
          bar += '+'.repeat(stars).green.bgGreen
          bar += ' '.repeat(half - stars)
        } else {
          stars = Math.min(Math.round(((50 - s.period.rsi) / 50) * half) + 1, half)
          bar += ' '.repeat(half - stars)
          bar += '-'.repeat(stars).red.bgRed
          bar += ' '.repeat(half)
        }
        process.stdout.write(' ' + bar)
      } else {
        process.stdout.write(' '.repeat(11))
      }
      if (s.strategy.onReport) {
        const cols = s.strategy.onReport.call(s.ctx, s)
        cols.forEach(function (col) {
          process.stdout.write(col)
        })
      }
      if (s.buy_order) {
        process.stdout.write(z(9, 'buying', ' ').green)
      } else if (s.sell_order) {
        process.stdout.write(z(9, 'selling', ' ').red)
      } else if (s.action) {
        process.stdout.write(z(9, s.action, ' ')[s.action === 'bought' ? 'green' : 'red'])
      } else if (s.signal) {
        process.stdout.write(z(9, s.signal || '', ' ')[s.signal ? s.signal === 'buy' ? 'green' : 'red' : 'grey'])
      } else if (s.last_trade_worth && !s.buy_order && !s.sell_order) {
        process.stdout.write(z(8, pct(s.last_trade_worth), ' ')[s.last_trade_worth > 0 ? 'green' : 'red'])
      } else {
        process.stdout.write(z(9, '', ' '))
      }
      const origCapital = s.orig_capital || s.start_capital
      const origPrice = s.orig_price || s.start_price
      if (origCapital) {
        const assetCol = n(s.balance.asset).format(s.asset === 'BTC' ? '0.00000' : '0.00') + ' ' + s.asset
        assetColWidth = Math.max(assetCol.length + 1, assetColWidth)
        process.stdout.write(z(assetColWidth, assetCol, ' ').white)
        const currencyCol = n(s.balance.currency).format(isFiat() ? '0.00' : '0.00000') + ' ' + s.currency
        currencyColWidth = Math.max(currencyCol.length + 1, currencyColWidth)
        process.stdout.write(z(currencyColWidth, currencyCol, ' ').yellow)
        const consolidated = n(s.balance.currency).add(n(s.period.close).multiply(s.balance.asset)).value()
        const profit = (consolidated - origCapital) / origCapital
        process.stdout.write(z(8, pct(profit), ' ')[profit >= 0 ? 'green' : 'red'])
        const buyHold = s.period.close * (origCapital / origPrice)
        const overBuyHoldPct = (consolidated - buyHold) / buyHold
        process.stdout.write(z(7, pct(overBuyHoldPct), ' ')[overBuyHoldPct >= 0 ? 'green' : 'red'])
      }
      if (!isProgress) {
        process.stdout.write('\n')
      }
    }

    return {
      writeHeader: function () {
        process.stdout.write([
          z(19, 'DATE', ' ').grey,
          z(17, 'PRICE', ' ').grey,
          z(9, 'DIFF', ' ').grey,
          z(15, 'VOL', ' ').grey,
          z(12, 'RSI', ' ').grey,
          z(32, 'ACTIONS', ' ').grey,
          z(25, 'BAL', ' ').grey,
          z(22, 'PROFIT', ' ').grey
        ].join('') + '\n')
      },
      update: function (trades, isPreroll, cb) {
        if (typeof isPreroll === 'function') {
          cb = isPreroll
          isPreroll = false
        }
        trades.sort(function (a, b) {
          if (a.time < b.time) return -1
          if (a.time > b.time) return 1
          return 0
        })
        msg(`Processing ${trades.length} trades`)
        const tasks = trades.map(function (trade) {
          return function (done) {
            if (s.period && trade.time < s.period.time) {
              return done()
            }
            const periodId = tb(trade.time).resize(so.period).toString()
            const day = tb(trade.time).resize('1d')
            if (s.last_day && s.last_day.toString() && day.toString() !== s.last_day.toString()) {
              s.day_count++
            }
            s.last_day = day
            if (!s.period) {
              initBuffer(trade)
            }
            s.in_preroll = isPreroll || (so.start && trade.time < so.start)
            if (periodId !== s.period.period_id) {
              s.strategy.onPeriod.call(s.ctx, s, function () {
                s.acted_on_stop = false
                if (!s.in_preroll && !so.manual) {
                  executeStop(true)
                  if (s.signal) {
                    executeSignal(s.signal)
                  }
                }
                writeReport()
                s.lookback.unshift(s.period)
                s.action = null
                s.signal = null
                initBuffer(trade)
                withOnPeriod()
              })
            } else {
              withOnPeriod()
            }
            function withOnPeriod () {
              onTrade(trade)
              if (!s.in_preroll) {
                if (so.mode !== 'live' && !s.start_capital) {
                  s.start_capital = 0
                  s.start_price = trade.price
                  if (so.asset_capital) {
                    s.start_capital += so.asset_capital * s.start_price
                  }
                  if (so.currency_capital) {
                    s.start_capital += so.currency_capital
                  }
                }
                if (!so.manual) {
                  executeStop()
                  if (s.signal) {
                    executeSignal(s.signal)
                    s.signal = null
                  }
                }
                if (so.mode !== 'live') {
                  adjustBid(trade)
                  executeOrder(trade)
                }
              }
              s.last_period_id = periodId
              setImmediate(done)
            }
          }
        })
        series(tasks, cb)
      },

      exit: function (cb) {
        cb()
      },

      executeSignal: executeSignal,
      writeReport: writeReport,
      syncBalance: syncBalance,
      formatCurrency: fc,
      formatAsset: fa
    }

    function canTransact (product, size, price) {
      if (product.min_size && Number(size) < Number(product.min_size)) {
        msg(`Size of ${Number(size)} less than minimum size of ${product.min_size}`)

        return false
      }

      const total = n(size).multiply(price).value()
      if (product.min_total && total < Number(product.min_total)) {
        msg(`Total of ${total} less than minimum total of ${product.min_total}`)

        return false
      }

      return true
    }
  }
}
