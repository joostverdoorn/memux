import { Observable, Subject } from '@reactivex/rxjs';
import { EARLIEST_OFFSET, GroupConsumer, ConsistentAssignmentStrategy } from 'no-kafka';
import * as uuid from 'node-uuid';
import PQueue = require('p-queue');

import { Operation, isOperation, Progress, SSLConfig  } from './index';

import * as Logger from './logger';

const OFFSET_COMMIT_INTERVAL = 1000;
const RETENTION_TIME = 1000 * 365 * 24;

export type SourceConfig<T> = {
  url: string;
  name: string;
  topic: string;
  receive: (action: Operation<T>) => Promise<void>;
  ssl?: SSLConfig,
  concurrency?: number
};

export type KafkaMessage = {
  message: {
    value: Buffer | string
  }
  offset?: number;
};

const parseMessage = ({ offset, message: { value } }: KafkaMessage) => {
  const data = value.toString();
  let message: string;

  try {
    message = JSON.parse(data);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }

  return { message, offset };
};

export const createReceive = async <T>({ url, name, topic, receive, ssl = {}, concurrency = 8 }: SourceConfig<T>) => {
  if (!(typeof url === 'string' && typeof name === 'string' && typeof topic === 'string')) {
    throw new Error('createSource should be called with a config containing a url, name, topic and receiveFn.');
  }

  const consumer = new GroupConsumer({
    connectionString: url,
    ssl,
    groupId: name,
    startingOffset: EARLIEST_OFFSET,
    recoveryOffset: EARLIEST_OFFSET,
    sessionTimeout: 30000,
    heartbeatTimeout: 25000,
    handlerConcurrency: concurrency,
    logger: {
      logFunction: Logger.log
    }
  } as any);

  console.log('Queueing receive with concurrency:', concurrency);
  const queue = new PQueue({
    concurrency
  });

  const dataHandler = async (messageSet, topic, partition) => {
    return await Promise.all(messageSet.map(parseMessage).map(({ message, offset}) => {
      if (!isOperation<T>(message)) throw new Error(`Non-action encountered: ${message}`);
      const progress = { topic, partition, offset };
      return queue.add(async () => {
        await receive(message);
        return consumer.commitOffset(progress);
      })
    }));
  };

  const strategies = [{
    subscriptions: [ topic ],
    metadata: {
      id: `${name}-${uuid.v4()}`,
      weight: 50
    },
    strategy: new ConsistentAssignmentStrategy(),
    handler: dataHandler

  }];

  return consumer.init(strategies);
};
