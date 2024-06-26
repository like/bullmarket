const EventEmitter = require('events')
const fetch = require('like-fetch')
const setCookie = require('set-cookie-parser')
const cookie = require('cookie')
const FormData = require('form-data')
const WebSocket = require('ws')

const API_URL = 'https://www.bullmarketbrokers.com'
const HUB_URL = 'https://hub.bullmarketbrokers.com'
const WS_URL = 'wss://hub.bullmarketbrokers.com'
const SEP = '\x1e'

const GROUPS = ['merval', 'panel general', 'cedears', 'opciones', 'bonos']
const ORDER_TYPES = { market: 1, limit: 2, stop: 4 }
const MARKET_TYPES = ['BYMA', 'QS']

module.exports = class BullMarket {
  constructor (opts = {}) {
    this.email = opts.email
    this.password = opts.password
    this.fingerprint = opts.fingerprint // Get your verified fingerprint by inspecting elements at /Security/SignIn

    this.userAgent = opts.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    this.session = opts.session || null

    this._keepAlive = null

    this.hub = new Hub()
  }

  async login () {
    const response = await fetch(API_URL + '/Security/SignIn', {
      method: 'GET',
      headers: {
        Origin: API_URL,
        'User-Agent': this.userAgent
      }
    })

    const cookies = getCookies(response)
    const forgeryKey = Object.keys(cookies).find(name => name.startsWith('.AspNetCore.Antiforgery'))

    if (!cookies.BullMarketGroup || !cookies[forgeryKey]) {
      throw new Error('Invalid credentials (first step)')
    }

    const html = await response.text()
    const form = html.match(/<input name="__RequestVerificationToken" type="hidden" value="(.*?)"/i)
    const __RequestVerificationToken = form ? form[1] : null

    const response2 = await fetch(API_URL + '/Security/SignIn', {
      method: 'POST',
      headers: {
        Origin: API_URL,
        'User-Agent': this.userAgent,
        Cookie: serializeCookies(cookies)
      },
      requestType: 'url',
      body: {
        __RequestVerificationToken,
        FingerPrint: this.fingerprint,
        Email: this.email,
        Password: this.password
      },
      redirect: 'manual'
    })

    if (response2.status !== 302) throw new Error('Invalid credentials or unknown error (status: ' + response2.status + ')')

    const location = response2.headers.get('location') || ''
    if (location.includes('/Home/Error/')) throw new Error('Unknown error')
    else if (location.endsWith('/Security/SignIn/WithOtp')) throw new Error('OTP is required (wrong fingerprint)')

    const cookies2 = getCookies(response2)

    if (!cookies2.BMB || !cookies2['.AspNetCore.Session']) {
      throw new Error('Invalid credentials (second step)')
    }

    this.session = {
      ...cookies,
      ...cookies2
    }

    this._setKeepAlive()
  }

  async logout (opts = {}) {
    this._clearKeepAlive()

    const session = this.session
    this.session = null

    if (opts.logout !== false) {
      await this.api('/Security/SignIn/Logout', {
        method: 'GET',
        headers: {
          Cookie: serializeCookies(session)
        }
      })
    }

    await this.hub.disconnect()
  }

  _setKeepAlive () {
    if (this._keepAlive) return

    this._keepAlive = setInterval(this._sendKeepAlive.bind(this), 10 * 60 * 1000)
  }

  _clearKeepAlive () {
    if (this._keepAlive === null) return

    clearInterval(this._keepAlive)
    this._keepAlive = null
  }

  async _sendKeepAlive () {
    try {
      const response = await fetch(API_URL + '/Clients/Dashboard', {
        method: 'GET',
        headers: {
          Cookie: serializeCookies(this.session)
        },
        redirect: 'manual'
      })

      if (this.session === null) return

      const cookies = getCookies(response)

      if (cookies.BMB) {
        this.session.BMB = cookies.BMB
      }
    } catch {}
  }

  createHub () {
    return new Hub()
  }

  // TODO: isVerified () {}

  async getStockAccounts () {
    return this.api('/home/GetStockAccountsForDropdown')
  }

  async setStockAccount (stockAccountNumber) {
    return this.api('/Home/SetStockAccountJson?stockAccountNumber=' + stockAccountNumber)
  }

  async getScreen (stockAccountNumber) {
    return this.api('/Operations/StockAccountQueries/GetScreen?stockAccountNumber=' + stockAccountNumber)
  }

  async fixOrder (stockAccountNumber, { symbol, amount, type, term, side, quantity, securityType, price, stopPrice, settleDate, market = 'BYMA' } = {}) {
    amount = parseFloat(amount)
    if (Number.isNaN(amount)) throw new Error('Invalid amount')

    const orderType = ORDER_TYPES[type]
    if (!orderType) throw new Error('Invalid order type')

    if (!MARKET_TYPES.includes(market)) throw new Error('Invalid market type')

    const body = {
      market,
      account: stockAccountNumber,
      amount: encodeURIComponent(amount.toString().replace('.', ',')),
      orderType, // 1 = market, 2 = limit, 4 = limit with stop
      securityType, // CS = local stock, CD = foreign stock, GO = bonds
      symbol,
      timeInForce: 0,
      expireDate: '',
      currency: 'ARS',
      quantity,
      settleDate: '',
      source: '',
      referralLink: '',
      regulationAccepted: false,
      price: encodeURIComponent((price || '').toString().replace('.', ',')), // Limit price
      stopPrice: encodeURIComponent((stopPrice || '').toString().replace('.', ',')), // Stop price
      send: true,
      forceOrder: false,
      orderCapacity: 'B',
      minimumOperationValue: ''
    }

    if (market === 'BYMA') {
      body.side = side === 'buy' ? 1 : 2
      body.settlType = encodeTerm(term)
    } else if (market === 'QS') {
      body.side = 2 // 2 = place
      body.settleDate = settleDate
    }

    const output = await this.api('/Operations/Orders/FixOrder', {
      requestType: 'url',
      body
    })

    if (output?.result !== true) {
      const message = output?.description?.length ? output.description[0] : ''

      const minimumOrderQuantity = message.match(/La cantidad m(?:í|i)nima para operar es ([\d]+)\.?/i)
      if (minimumOrderQuantity) {
        const err = new Error('Minimum order quantity is required')
        err.code = 'MINIMUM_ORDER_QUANTITY'
        err.quantity = parseInt(minimumOrderQuantity[1])
        throw err
      }

      const marketClosed = message.match(/El horario para colocar (?:ó|o)rdenes de (.*) es de (\d+:\d+)(?:hs)? a (\d+:\d+)(?:hs)?\.?/i)
      if (marketClosed) {
        const err = new Error('Market is closed: ' + marketClosed[1] + '. Open hours: ' + marketClosed[2] + ' to ' + marketClosed[3])
        err.code = 'MARKET_CLOSED'
        throw err
      }

      throw new Error(message || 'Order failed')
    }

    return output
  }

  async getOrders (stockAccountNumber, opts = {}) {
    const onlyPending = !!opts.pending
    return this.api('/Operations/orders/GetOrders?stockAccountNumber=' + stockAccountNumber + '&onlyPending=' + onlyPending)
  }

  async orderAlreadyExists (stockAccountNumber, { symbol, quantity, side } = {}) {
    side = side === 'buy' ? 1 : 2

    return this.api('/Operations/Orders/OrderAlreadyExists?account=' + stockAccountNumber + '&price=&symbol=' + symbol + '&quantity=' + quantity + '&side=' + side, {
      method: 'GET'
    })
  }

  async getDollarsPrice () {
    return this.api('/Information/StockPrice/GetDollarsPrice')
  }

  async getStockPrices (index, term) {
    index = index.replace(/\s/g, '+').toLowerCase() // => 'merval', 'panel general', 'opciones', 'bonos', 'cedears', 'cauciones'
    term = index === 'cauciones' ? '' : term

    return this.api('/Information/StockPrice/GetStockPrices?_ts=' + Date.now() + '&term=' + encodeTerm(term) + '&index=' + index + '&sortColumn=ticker&isAscending=true')
  }

  async initializeStockPrice (symbol, term) {
    return this.api('/Operations/Orders/InitializeStockPrice?symbol=' + symbol + '&term=' + encodeTerm(term))
  }

  async getStockPrice (symbols, term) {
    const form = new FormData()

    for (let i = 0; i < symbols.length; i++) {
      if (!symbols[i].term) throw new Error('Must set a term (ci or 48hs)')

      form.append('stockPrices[' + i + '].ticker', symbols[i].symbol)
      form.append('stockPrices[' + i + '].term', encodeTerm(symbols[i].term))
    }

    return this.api('/Information/StockPrice/GetStockPrice', {
      method: 'POST',
      requestType: 'form',
      body: form
    })
  }

  async getAccountBalance (stockAccountNumber, opts = {}) {
    const page = opts.page || 1
    const ascending = opts.ascending || false

    return this.api('/Clients/AccountBalance/GetAccountBalance?sortColumn=orderColumn&isAscending=' + ascending + '&currency=PESOS&stockAccountNumber=' + stockAccountNumber + '&searchDateStart=&searchDateEnd=&PageSize=20&page=' + page)
  }

  async getStockDescription (symbol) {
    return this.api('/Information/StockData/getStockDescription?symbol=' + symbol)
  }

  async tradingTime () {
    return this.api('/Information/TradingView/time')
  }

  async tradingHistory (symbol, opts = {}) {
    return this.api('/Information/TradingView/history?symbol=' + symbol + '&resolution=D&from=' + opts.from + '&to=' + opts.to)
  }

  // TODO: /Home/GetCurrentUserSiteNotifications
  // TODO: /Operations/Orders/CancelOrder?bmbId=<id URI encoded> (GET) // => true
  // TODO: /Operations/Orders/CanForceOrder?account=<n>
  // TODO: /Operations/Orders/GetProducts?market=BYMA&stockAccountNumber=<N>&query=SHO
  // TODO: /Operations/Orders/OrderAlreadyExists?account=<N>&price=&symbol=SHOP&quantity=1&side=1

  async api (pathname, opts = {}) {
    const response = await fetch(API_URL + pathname, {
      method: opts.method || 'POST',
      headers: {
        Cookie: serializeCookies(this.session),
        ...opts.headers
      },
      requestType: opts.requestType,
      body: opts.body,
      redirect: 'manual'
    })

    const contentType = response.headers.get('content-type') || ''
    const contentLength = response.headers.get('content-length')

    // For now checking for text due logout API, probably make a contentType option or something to return the response
    const isHTML = contentType.includes('text/html')
    if (isHTML) return response.text()

    // getStockPrices: While being unlogged returns no Content-Type header
    if (!contentType) return null

    // getStockAccounts: If account is not "verified" returns Content-Length with zero value
    if (contentLength !== null && contentLength === 0) return null

    return response.json()
  }
}

class Hub extends EventEmitter {
  constructor () {
    super()

    this.ws = null

    this._onopen = this._onopen.bind(this)
    this._onmessage = this._onmessage.bind(this)
    this._onclose = this._onclose.bind(this)
    this._onerror = this._onerror.bind(this)

    this._keepAlive = null
    this._sendKeepAlive = this._sendKeepAlive.bind(this)

    this._invocationId = -1

    this._connecting = null
    this._disconnecting = null
    this._connected = false

    this.on('error', noop)
  }

  async negotiate () {
    const response = await fetch(HUB_URL + '/stock-prices-hub/negotiate?token=00000000-0000-0000-0000-000000000000&negotiateVersion=1', {
      method: 'POST',
      headers: {
        'X-Signalr-User-Agent': 'Microsoft SignalR/5.0 (5.0.8; Unknown OS; Browser; Unknown Runtime Version)'
      }
    })
    return response.json()
  }

  async connect (info) {
    if (this._connecting) return this._connecting
    this._connecting = this._connect(info)
    return this._connecting
  }

  async disconnect (err) {
    if (this._disconnecting) return this._disconnecting
    this._disconnecting = this._disconnect(err)
    return this._disconnecting
  }

  async _connect (info) {
    if (this._connected === true) {
      if (this._disconnecting !== null) await this._disconnecting.catch(noop)
      else await this.disconnect().catch(noop)
    }

    try {
      if (!info) info = await this.negotiate()

      this._invocationId = 0

      this.ws = new WebSocket(WS_URL + '/stock-prices-hub?token=00000000-0000-0000-0000-000000000000&id=' + info.connectionToken, {
        origin: API_URL
      })

      this.ws.on('open', this._onopen)
      this.ws.on('message', this._onmessage)
      this.ws.on('close', this._onclose)
      this.ws.on('error', this._onerror)

      await waitForWebSocket(this.ws)

      this.send({ protocol: 'json', version: 1 })

      await this._waitForMessage(msg => !msg.type)
    } finally {
      this._connecting = null
      this._disconnecting = null
    }

    this._keepAlive = setInterval(this._sendKeepAlive, 15000)
    this._connected = true
  }

  async _disconnect (err) {
    if (this._connected === false && this._connecting !== null) await this._connecting.catch(noop)

    try {
      if (err) throw err

      if (this.ws) {
        if (this.ws.readyState === 0) await waitForWebSocket(this.ws)
        if (this.ws.readyState === 1) this.ws.close()
        if (this.ws.readyState === 2) await new Promise(resolve => this.ws.once('close', resolve))
      }
    } catch (err) {
      try { this.ws.close() } catch {}
      this._onclose()
      throw err
    } finally {
      this._connected = false
    }
  }

  _onopen () {
  }

  _onmessage (msg) {
    // ACK:
    // No type = Connected
    // Type 1 = Joins
    // Type 3 = Invocation
    // Type 6 = Keep alive
    // Type 7 = Closed with error

    const messages = msg.toString().split(SEP)

    for (const message of messages) {
      if (!message) return

      const msg = JSON.parse(message)

      if (!msg.type && !msg.target) {
        this.emit('connect')
      }

      if (msg.type === 7) {
        this.emit('error', new Error('Closed with error by remote server'))
      }

      this.emit('message', msg)

      if (msg.type === 1) {
        if (msg.target === 'SendStock') {
          this.emit('stock', msg.arguments[0])
        }

        if (msg.target === 'SendMarketTotals') {
          this.emit('market-totals', msg.arguments[0])
        }

        if (msg.target === 'SendPrices') {
          msg.arguments[0].sort((a, b) => new Date(a.date) - new Date(b.date))

          for (const stock of msg.arguments[0]) {
            let group = stock.indexes.find(index => GROUPS.indexOf(index.name) > -1)

            if (!group) {
              // Sometimes an 'opcion' doesn't have an index
              if (stock.stockBaseTicker !== null) group = 'opciones'
            }

            if (!group) {
              const err = new Error('Group not found for ' + stock.ticker)
              err.code = 'GROUP_NOT_FOUND'
              err.stock = stock
              this.emit('warning', err)
              continue
            }

            this.emit('prices', stock)
            this.emit(group.name, stock)
          }
        }

        if (msg.target === 'SendIndexes') {
          for (const bond of msg.arguments[0]) this.emit('indexes', bond)
        }
      }

      if (msg.type === 3) {
        this.emit('invocation', msg)
      }

      if (msg.type === 6 && !msg.target) {
        this.emit('keep-alive')
      }
    }
  }

  _onerror (err) {
    this.emit('error', err)
  }

  _onclose () {
    this._clearKeepAlive()

    this.ws.removeListener('open', this._onopen)
    this.ws.removeListener('message', this._onmessage)
    this.ws.removeListener('close', this._onclose)
    this.ws.removeListener('error', this._onerror)

    this.emit('disconnect')
  }

  send (data) {
    if (this.ws.readyState !== 1) throw new Error('Hub is not connected')

    this.ws.send(JSON.stringify(data) + SEP)
  }

  _sendKeepAlive () {
    try {
      this.send({ type: 6 })
    } catch {}
  }

  _clearKeepAlive () {
    if (this._keepAlive === null) return

    clearInterval(this._keepAlive)
    this._keepAlive = null
  }

  async joinStockPriceChange (name, term) {
    const invocationId = (this._invocationId++).toString()

    this.send({
      arguments: [name, encodeTerm(term).toString()],
      invocationId,
      target: 'JoinStockPriceChange',
      type: 1
    })

    return this._waitForInvocation(invocationId)
  }

  async joinStockPricesGroup (name) {
    const invocationId = (this._invocationId++).toString()

    this.send({
      arguments: Array.isArray(name) ? name : [name, null],
      invocationId,
      target: 'JoinStockPricesGroup',
      type: 1
    })

    return this._waitForInvocation(invocationId)
  }

  _waitForInvocation (invocationId) {
    return this._waitForMessage(msg => msg.type === 3 && msg.invocationId === invocationId)
  }

  _waitForMessage (cb) {
    return new Promise((resolve, reject) => {
      const ws = this.ws

      const cleanup = () => {
        this.removeListener('message', onmessage)
        ws.removeListener('close', onclose)
      }

      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('ACK timed out'))
      }, 15000)

      const onmessage = (msg) => {
        if (!cb(msg)) return

        clearTimeout(timeout)
        cleanup()
        resolve()
      }

      const onclose = () => {
        clearTimeout(timeout)
        cleanup()
        reject(new Error('Connection destroyed'))
      }

      this.on('message', onmessage)
      ws.on('close', onclose)
    })
  }
}

function encodeTerm (term) {
  if (!term) return ''
  return term === 'ci' ? 1 : 2
}

function waitForWebSocket (ws) {
  return new Promise((resolve, reject) => {
    ws.on('open', onopen)
    ws.on('close', onclose)
    ws.on('error', onerror)

    function onopen () {
      cleanup()
      resolve()
    }

    function onclose () {
      cleanup()
      reject(new Error('Socket closed'))
    }

    function onerror (err) {
      cleanup()
      reject(err)
    }

    function cleanup () {
      ws.removeListener('open', onopen)
      ws.removeListener('close', onclose)
      ws.removeListener('error', onerror)
    }
  })
}

function getCookies (response) {
  const headerSetCookie = response.headers.get('set-cookie')
  const splitCookieHeaders = setCookie.splitCookiesString(headerSetCookie)
  return setCookie.parse(splitCookieHeaders, { map: true })
}

function serializeCookies (cookies) {
  if (!cookies) return ''
  const arr = []
  for (const k in cookies) {
    const c = cookies[k]
    arr.push(cookie.serialize(c.name, c.value))
  }
  return arr.join('; ')
}

function noop () {}
