/** @decorator */

import { TRADER_DATUM } from '../const.js';
import { Trader } from './common-trader.js';
import { applyMixins } from '../utilities/apply-mixins.js';
import { cyrillicToLatin } from '../intl.js';
import { debounce } from '../ppp-throttle.js';
import { createClient } from '../../vendor/nice-grpc-web/client/ClientFactory.js';
import { createChannel } from '../../vendor/nice-grpc-web/client/channel.js';
import { Metadata } from '../../vendor/nice-grpc-web/nice-grpc-common/Metadata.js';
import {
  MarketDataStreamServiceDefinition,
  MarketDataServiceDefinition,
  SubscriptionAction,
  TradeDirection
} from '../../vendor/tinkoff/definitions/market-data.js';
import { isAbortError } from '../../vendor/abort-controller-x.js';
import ppp from '../../ppp.js';

// noinspection JSUnusedGlobalSymbols
/**
 * @typedef {Object} TinkoffGrpcWebTrader
 */

export function toQuotation(value) {
  const sign = value < 0 ? -1 : 1;
  const absValue = Math.abs(value);
  const units = Math.floor(absValue);
  const nano = Math.round((absValue - units) * 1000000000);

  return {
    units: sign * units,
    nano: sign * nano
  };
}

export function toNumber(value) {
  return value ? value.units + value.nano / 1000000000 : value;
}

class TinkoffGrpcWebTrader extends Trader {
  #clients = new Map();

  #metadata;

  #marketDataAbortController;

  // Key: figi ; Value: instrument object
  #figis = new Map();

  // Key: widget instance; Value: [{ field, datum }] array
  subs = {
    orderbook: new Map(),
    allTrades: new Map()
  };

  // Key: instrumentId; Value: { instrument, refCount }
  // Value contains lastOrderbookData for orderbook
  refs = {
    orderbook: new Map(),
    allTrades: new Map()
  };

  constructor(document) {
    super(document);

    this.#metadata = new Metadata({
      Authorization: `Bearer ${this.document.broker.apiToken}`,
      'x-app-name': `${ppp.keyVault.getKey('github-login')}.ppp`
    });
  }

  getOrCreateClient(service) {
    if (!this.#clients.has(service)) {
      this.#clients.set(
        service,
        createClient(
          service,
          createChannel('https://invest-public-api.tinkoff.ru:443'),
          {
            '*': {
              metadata: this.#metadata
            }
          }
        )
      );
    }

    return this.#clients.get(service);
  }

  @debounce(100)
  resubscribeToMarketData(reconnect = false) {
    return this.#resubscribeToMarketData(reconnect);
  }

  async #resubscribeToMarketData(reconnect = false) {
    if (!this.refs.orderbook.size && !this.refs.allTrades.size) {
      return;
    }

    const marketDataServerSideStreamRequest = {};
    const orderbookRefsArray = [...this.refs.orderbook.values()];
    const allTradesRefsArray = [...this.refs.allTrades.values()];

    if (orderbookRefsArray.length) {
      marketDataServerSideStreamRequest.subscribeOrderBookRequest = {
        subscriptionAction: SubscriptionAction.SUBSCRIPTION_ACTION_SUBSCRIBE,
        instruments: []
      };

      [...this.refs.orderbook.values()].forEach(({ instrument }) => {
        marketDataServerSideStreamRequest.subscribeOrderBookRequest.instruments.push(
          {
            instrumentId: instrument.tinkoffFigi,
            depth: 50
          }
        );
      });
    }

    if (allTradesRefsArray.length) {
      marketDataServerSideStreamRequest.subscribeTradesRequest = {
        subscriptionAction: SubscriptionAction.SUBSCRIPTION_ACTION_SUBSCRIBE,
        instruments: []
      };

      [...this.refs.allTrades.values()].forEach(({ instrument }) => {
        marketDataServerSideStreamRequest.subscribeTradesRequest.instruments.push(
          {
            instrumentId: instrument.tinkoffFigi
          }
        );
      });
    }

    const client = createClient(
      MarketDataStreamServiceDefinition,
      createChannel('https://invest-public-api.tinkoff.ru:443'),
      {
        '*': {
          metadata: this.#metadata
        }
      }
    );

    this.#marketDataAbortController?.abort?.();

    this.#marketDataAbortController = new AbortController();

    const stream = client.marketDataServerSideStream(
      marketDataServerSideStreamRequest,
      {
        signal: this.#marketDataAbortController?.signal
      }
    );

    try {
      if (reconnect) {
        await Promise.all(
          [...this.refs.orderbook.values()].map(({ instrument }) => {
            return (async () => {
              this.onOrderbookMessage({
                orderbook: await this.getOrCreateClient(
                  MarketDataServiceDefinition
                ).getOrderBook({
                  instrumentId: instrument.tinkoffFigi,
                  depth: 50
                }),
                instrument
              });
            })();
          })
        );
      }

      for await (const data of stream) {
        if (data.orderbook) {
          this.onOrderbookMessage({
            orderbook: data.orderbook,
            instrument: this.#figis.get(data.orderbook.figi)
          });
        } else if (data.trade) {
          this.onTradeMessage({
            trade: data.trade,
            instrument: this.#figis.get(data.trade.figi)
          });
        }
      }

      this.resubscribeToMarketData(true);
    } catch (e) {
      if (!isAbortError(e)) {
        console.error(e);

        setTimeout(() => {
          this.resubscribeToMarketData(true);
        }, Math.max(this.document.reconnectTimeout ?? 1000, 1000));
      }
    }
  }

  getSymbol(instrument = {}) {
    let symbol = instrument.symbol;

    if (/~/gi.test(symbol)) symbol = symbol.split('~')[0];

    return symbol;
  }

  subsAndRefs(datum) {
    return {
      [TRADER_DATUM.ORDERBOOK]: [this.subs.orderbook, this.refs.orderbook],
      [TRADER_DATUM.MARKET_PRINT]: [this.subs.allTrades, this.refs.allTrades]
    }[datum];
  }

  async addFirstRef(instrument, refs) {
    refs.set(instrument._id, {
      refCount: 1,
      instrument
    });

    this.#figis.set(instrument.tinkoffFigi, instrument);

    if (refs === this.refs.orderbook) {
      this.onOrderbookMessage({
        orderbook: await this.getOrCreateClient(
          MarketDataServiceDefinition
        ).getOrderBook({
          instrumentId: instrument.tinkoffFigi,
          depth: 50
        }),
        instrument
      });
    }

    if (refs === this.refs.orderbook || refs === this.refs.allTrades) {
      this.resubscribeToMarketData();
    }
  }

  async removeLastRef(instrument, refs) {
    if (refs === this.refs.orderbook) {
      this.refs.orderbook.delete(instrument._id);
    }

    if (refs === this.refs.allTrades) {
      this.refs.allTrades.delete(instrument._id);
    }

    if (!this.refs.orderbook.size && !this.refs.allTrades.size) {
      // Abort market data stream if everything is empty.
      this.#marketDataAbortController?.abort?.();
    }
  }

  onOrderbookMessage({ orderbook, instrument }) {
    if (orderbook && instrument) {
      for (const [source, fields] of this.subs.orderbook) {
        if (source.instrument?._id === instrument._id) {
          const ref = this.refs.orderbook.get(source.instrument._id);

          if (ref) {
            ref.lastOrderbookData = orderbook;

            for (const { field, datum } of fields) {
              switch (datum) {
                case TRADER_DATUM.ORDERBOOK:
                  source[field] = {
                    bids:
                      orderbook?.bids?.map?.((b) => {
                        return {
                          price: toNumber(b.price),
                          volume: b.quantity
                        };
                      }) ?? [],
                    asks:
                      orderbook?.asks?.map?.((a) => {
                        return {
                          price: toNumber(a.price),
                          volume: a.quantity
                        };
                      }) ?? []
                  };

                  break;
              }
            }
          }
        }
      }
    }
  }

  async allTrades({ instrument, depth }) {
    if (instrument) {
      const to = new Date();
      const from = new Date();

      to.setUTCHours(to.getUTCHours() + 1);
      from.setUTCHours(from.getUTCHours() - 1);

      const { trades } = await this.getOrCreateClient(
        MarketDataServiceDefinition
      ).getLastTrades({
        instrumentId: instrument.tinkoffFigi,
        from,
        to
      });

      return trades
        .slice(-depth)
        .reverse()
        .map((trade) => {
          const timestamp = trade.time.valueOf();
          const price = toNumber(trade.price);

          return {
            orderId: `${instrument.symbol}|${trade.direction}|${price}|${trade.quantity}|${timestamp}`,
            side:
              trade.direction === TradeDirection.TRADE_DIRECTION_BUY
                ? 'buy'
                : trade.direction === TradeDirection.TRADE_DIRECTION_SELL
                ? 'sell'
                : '',
            time: trade.time.toISOString(),
            timestamp,
            symbol: instrument.symbol,
            price,
            volume: trade.quantity
          };
        });
    }

    return [];
  }

  onTradeMessage({ trade, instrument }) {
    if (trade && instrument) {
      for (const [source, fields] of this.subs.allTrades) {
        if (source.instrument?._id === instrument._id) {
          for (const { field, datum } of fields) {
            switch (datum) {
              case TRADER_DATUM.MARKET_PRINT:
                const timestamp = trade.time.valueOf();
                const price = toNumber(trade.price);

                source[field] = {
                  orderId: `${instrument.symbol}|${trade.direction}|${price}|${trade.quantity}|${timestamp}`,
                  side:
                    trade.direction === TradeDirection.TRADE_DIRECTION_BUY
                      ? 'buy'
                      : trade.direction === TradeDirection.TRADE_DIRECTION_SELL
                      ? 'sell'
                      : '',
                  time: trade.time.toISOString(),
                  timestamp,
                  symbol: instrument.symbol,
                  price,
                  volume: trade.quantity
                };

                break;
            }
          }
        }
      }
    }
  }

  async instrumentChanged(source, oldValue, newValue) {
    await super.instrumentChanged(source, oldValue, newValue);

    if (newValue?._id) {
      // Handle no real subscription case for orderbook.
      this.onOrderbookMessage({
        orderbook: this.refs.orderbook.get(newValue._id)?.lastOrderbookData,
        instrument: newValue
      });
    }
  }

  getBroker() {
    return this.document.broker.type;
  }

  async search(searchText) {
    if (searchText?.trim()) {
      searchText = searchText.trim();

      const lines = ((context) => {
        const collection = context.services
          .get('mongodb-atlas')
          .db('ppp')
          .collection('instruments');

        const exactSymbolMatch = collection
          .find({
            $and: [
              {
                exchange: {
                  $in: ['spbex', 'moex']
                }
              },
              {
                broker: '$broker'
              },
              {
                $or: [
                  {
                    symbol: '$text'
                  },
                  {
                    symbol: '$latin'
                  }
                ]
              }
            ]
          })
          .limit(1);

        const regexSymbolMatch = collection
          .find({
            $and: [
              {
                exchange: {
                  $in: ['spbex', 'moex']
                }
              },
              {
                broker: '$broker'
              },
              {
                symbol: { $regex: '(^$text|^$latin)', $options: 'i' }
              }
            ]
          })
          .limit(20);

        const regexFullNameMatch = collection
          .find({
            $and: [
              {
                exchange: {
                  $in: ['spbex', 'moex']
                }
              },
              {
                broker: '$broker'
              },
              {
                fullName: { $regex: '($text|$latin)', $options: 'i' }
              }
            ]
          })
          .limit(20);

        return { exactSymbolMatch, regexSymbolMatch, regexFullNameMatch };
      })
        .toString()
        .split(/\r?\n/);

      lines.pop();
      lines.shift();

      return ppp.user.functions.eval(
        lines
          .join('\n')
          .replaceAll('$broker', this.getBroker?.() ?? '')
          .replaceAll('$text', searchText.toUpperCase())
          .replaceAll('$latin', cyrillicToLatin(searchText).toUpperCase())
      );
    }
  }
}

export default applyMixins(TinkoffGrpcWebTrader);
