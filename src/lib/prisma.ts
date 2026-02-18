import { getCloudflareContext } from '@opennextjs/cloudflare';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient as RuntimePrismaClient } from '@prisma/client';
import { readReplicas } from '@prisma/extension-read-replicas';
import debug from 'debug';
import { CloudflareSocket } from 'pg-cloudflare';
import type { PrismaClient as GeneratedPrismaClient } from '@/generated/prisma/client';
import { DEFAULT_PAGE_SIZE, FILTER_COLUMNS, OPERATORS, SESSION_COLUMNS } from './constants';
import { filtersObjectToArray } from './params';
import type { Operator, QueryFilters, QueryOptions } from './types';

const log = debug('umami:prisma');

const PRISMA = 'prisma';
let resolvedDatabaseUrl: string | null = null;

function ensureWasmStreamingPolyfills() {
  // Cloudflare workerd can miss streaming WASM helpers used by Prisma's runtime loader.
  if (typeof WebAssembly.compileStreaming !== 'function') {
    Object.assign(WebAssembly, {
      compileStreaming: async (source: Response | PromiseLike<Response>) => {
        const response = await source;
        const bytes = await response.arrayBuffer();
        return WebAssembly.compile(bytes);
      },
    });
  }

  if (typeof WebAssembly.instantiateStreaming !== 'function') {
    Object.assign(WebAssembly, {
      instantiateStreaming: async (
        source: Response | PromiseLike<Response>,
        importObject?: WebAssembly.Imports,
      ) => {
        const response = await source;
        const bytes = await response.arrayBuffer();
        return WebAssembly.instantiate(bytes, importObject);
      },
    });
  }
}

type RuntimeHyperdriveBinding = {
  connectionString?: string;
};

type RuntimeCloudflareEnv = {
  HYPERDRIVE?: RuntimeHyperdriveBinding;
};

function normalizeString(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function sanitizeConnectionString(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '[invalid-connection-string]';
  }
}

const PRISMA_LOG_OPTIONS = {
  log: [
    {
      emit: 'event' as const,
      level: 'query' as const,
    },
  ],
};

const DATE_FORMATS = {
  minute: 'YYYY-MM-DD HH24:MI:00',
  hour: 'YYYY-MM-DD HH24:00:00',
  day: 'YYYY-MM-DD HH24:00:00',
  month: 'YYYY-MM-01 HH24:00:00',
  year: 'YYYY-01-01 HH24:00:00',
};

const DATE_FORMATS_UTC = {
  minute: 'YYYY-MM-DD"T"HH24:MI:00"Z"',
  hour: 'YYYY-MM-DD"T"HH24:00:00"Z"',
  day: 'YYYY-MM-DD"T"HH24:00:00"Z"',
  month: 'YYYY-MM-01"T"HH24:00:00"Z"',
  year: 'YYYY-01-01"T"HH24:00:00"Z"',
};

function getAddIntervalQuery(field: string, interval: string): string {
  return `${field} + interval '${interval}'`;
}

function getDayDiffQuery(field1: string, field2: string): string {
  return `${field1}::date - ${field2}::date`;
}

function getCastColumnQuery(field: string, type: string): string {
  return `${field}::${type}`;
}

function getDateSQL(field: string, unit: string, timezone?: string): string {
  if (timezone && timezone !== 'utc') {
    return `to_char(date_trunc('${unit}', ${field} at time zone '${timezone}'), '${DATE_FORMATS[unit]}')`;
  }

  return `to_char(date_trunc('${unit}', ${field}), '${DATE_FORMATS_UTC[unit]}')`;
}

function getDateWeeklySQL(field: string, timezone?: string) {
  return `concat(extract(dow from (${field} at time zone '${timezone}')), ':', to_char((${field} at time zone '${timezone}'), 'HH24'))`;
}

export function getTimestampSQL(field: string) {
  return `floor(extract(epoch from ${field}))`;
}

function getTimestampDiffSQL(field1: string, field2: string): string {
  return `floor(extract(epoch from (${field2} - ${field1})))`;
}

function getSearchSQL(column: string, param: string = 'search'): string {
  return `and ${column} ilike {{${param}}}`;
}

function mapFilter(column: string, operator: string, name: string, type: string = '') {
  const value = `{{${name}${type ? `::${type}` : ''}}}`;

  switch (operator) {
    case OPERATORS.equals:
      return `${column} = ${value}`;
    case OPERATORS.notEquals:
      return `${column} != ${value}`;
    case OPERATORS.contains:
      return `${column} ilike ${value}`;
    case OPERATORS.doesNotContain:
      return `${column} not ilike ${value}`;
    default:
      return '';
  }
}

function getFilterQuery(filters: Record<string, any>, options: QueryOptions = {}): string {
  const query = filtersObjectToArray(filters, options).reduce(
    (arr, { name, column, operator, prefix = '' }) => {
      const isCohort = options?.isCohort;

      if (isCohort) {
        column = FILTER_COLUMNS[name.slice('cohort_'.length)];
      }

      if (column) {
        arr.push(`and ${mapFilter(`${prefix}${column}`, operator, name)}`);

        if (name === 'referrer') {
          arr.push(
            `and (website_event.referrer_domain != website_event.hostname or website_event.referrer_domain is null)`,
          );
        }
      }

      return arr;
    },
    [],
  );

  return query.join('\n');
}

function getCohortQuery(filters: QueryFilters = {}) {
  if (!filters || Object.keys(filters).length === 0) {
    return '';
  }

  const filterQuery = getFilterQuery(filters, { isCohort: true });

  return `join
    (select distinct website_event.session_id
    from website_event
    join session on session.session_id = website_event.session_id
      and session.website_id = website_event.website_id
    where website_event.website_id = {{websiteId}}
      and website_event.created_at between {{cohort_startDate}} and {{cohort_endDate}}
      ${filterQuery}
    ) cohort
    on cohort.session_id = website_event.session_id
    `;
}

function getDateQuery(filters: Record<string, any>) {
  const { startDate, endDate } = filters;

  if (startDate) {
    if (endDate) {
      return `and website_event.created_at between {{startDate}} and {{endDate}}`;
    } else {
      return `and website_event.created_at >= {{startDate}}`;
    }
  }

  return '';
}

function getQueryParams(filters: Record<string, any>) {
  return {
    ...filters,
    ...filtersObjectToArray(filters).reduce((obj, { name, operator, value }) => {
      obj[name] = ([OPERATORS.contains, OPERATORS.doesNotContain] as Operator[]).includes(operator)
        ? `%${value}%`
        : value;

      return obj;
    }, {}),
  };
}

function parseFilters(filters: Record<string, any>, options?: QueryOptions) {
  const joinSession = Object.keys(filters).find(key =>
    ['referrer', ...SESSION_COLUMNS].includes(key),
  );

  const cohortFilters = Object.fromEntries(
    Object.entries(filters).filter(([key]) => key.startsWith('cohort_')),
  );

  return {
    joinSessionQuery:
      options?.joinSession || joinSession
        ? `inner join session on website_event.session_id = session.session_id and website_event.website_id = session.website_id`
        : '',
    dateQuery: getDateQuery(filters),
    filterQuery: getFilterQuery(filters, options),
    queryParams: getQueryParams(filters),
    cohortQuery: getCohortQuery(cohortFilters),
  };
}

async function rawQuery(sql: string, data: Record<string, any>, name?: string): Promise<any> {
  if (process.env.LOG_QUERY) {
    log('QUERY:\n', sql);
    log('PARAMETERS:\n', data);
    log('NAME:\n', name);
  }
  const client = getPrismaClient();
  const params = [];
  const schema = getSchema();

  if (schema) {
    await client.$executeRawUnsafe(`SET search_path TO "${schema}";`);
  }

  const query = sql?.replaceAll(/\{\{\s*(\w+)(::\w+)?\s*}}/g, (...args) => {
    const [, name, type] = args;

    const value = data[name];

    params.push(value);

    return `$${params.length}${type ?? ''}`;
  });

  if (process.env.DATABASE_REPLICA_URL && '$replica' in client) {
    return client.$replica().$queryRawUnsafe(query, ...params);
  }

  return client.$queryRawUnsafe(query, ...params);
}

async function pagedQuery<T>(model: string, criteria: T, filters?: QueryFilters) {
  const client = getPrismaClient();
  const { page = 1, pageSize, orderBy, sortDescending = false, search } = filters || {};
  const size = +pageSize || DEFAULT_PAGE_SIZE;

  const data = await client[model].findMany({
    ...criteria,
    ...{
      ...(size > 0 && { take: +size, skip: +size * (+page - 1) }),
      ...(orderBy && {
        orderBy: [
          {
            [orderBy]: sortDescending ? 'desc' : 'asc',
          },
        ],
      }),
    },
  });

  const count = await client[model].count({ where: (criteria as any).where });

  return { data, count, page: +page, pageSize: size, orderBy, search };
}

async function pagedRawQuery(
  query: string,
  queryParams: Record<string, any>,
  filters: QueryFilters,
  name?: string,
) {
  const { page = 1, pageSize, orderBy, sortDescending = false } = filters;
  const size = +pageSize || DEFAULT_PAGE_SIZE;
  const offset = +size * (+page - 1);
  const direction = sortDescending ? 'desc' : 'asc';

  const statements = [
    orderBy && `order by ${orderBy} ${direction}`,
    +size > 0 && `limit ${+size} offset ${offset}`,
  ]
    .filter(n => n)
    .join('\n');

  const count = await rawQuery(`select count(*) as num from (${query}) t`, queryParams).then(
    res => res[0].num,
  );

  const data = await rawQuery(`${query}${statements}`, queryParams, name);

  return { data, count, page: +page, pageSize: size, orderBy };
}

function getSearchParameters(query: string, filters: Record<string, any>[]) {
  if (!query) return;

  const parseFilter = (filter: Record<string, any>) => {
    const [[key, value]] = Object.entries(filter);

    return {
      [key]:
        typeof value === 'string'
          ? {
              [value]: query,
              mode: 'insensitive',
            }
          : parseFilter(value),
    };
  };

  const params = filters.map(filter => parseFilter(filter));

  return {
    AND: {
      OR: params,
    },
  };
}

function transaction(input: any, options?: any) {
  return getPrismaClient().$transaction(input, options);
}

function getHyperdriveConnectionString(): string | null {
  try {
    const context = getCloudflareContext();
    const env = context?.env as RuntimeCloudflareEnv | undefined;
    return normalizeString(env?.HYPERDRIVE?.connectionString);
  } catch {
    return null;
  }
}

function getConnectionString(): string {
  const hyperdriveUrl = getHyperdriveConnectionString();

  if (hyperdriveUrl) {
    // Hyperdrive connection strings are request-scoped in Workers and must not be cached globally.
    process.env.DATABASE_URL = hyperdriveUrl;
    if (resolvedDatabaseUrl !== hyperdriveUrl) {
      log('Prisma DB URL resolved from HYPERDRIVE', sanitizeConnectionString(hyperdriveUrl));
      resolvedDatabaseUrl = hyperdriveUrl;
    }
    return hyperdriveUrl;
  }

  if (resolvedDatabaseUrl) {
    return resolvedDatabaseUrl;
  }

  const explicitDatabaseUrl = normalizeString(process.env.DATABASE_URL);

  if (explicitDatabaseUrl) {
    resolvedDatabaseUrl = explicitDatabaseUrl;
    log('Prisma DB URL resolved from DATABASE_URL', sanitizeConnectionString(explicitDatabaseUrl));
    return explicitDatabaseUrl;
  }

  throw new Error('DATABASE_URL is not defined and HYPERDRIVE binding is unavailable.');
}

function getSchema() {
  const connectionUrl = new URL(getConnectionString());

  return connectionUrl.searchParams.get('schema');
}

function getPoolConfig(connectionString: string) {
  return {
    connectionString,
    stream: ({ ssl }) => new CloudflareSocket(Boolean(ssl)),
  };
}

function getClient() {
  ensureWasmStreamingPolyfills();

  const url = getConnectionString();
  const replicaUrl = normalizeString(process.env.DATABASE_REPLICA_URL);
  const logQuery = process.env.LOG_QUERY;
  const schema = getSchema();
  const shouldReuseClient = !getHyperdriveConnectionString();

  const baseAdapter = new PrismaPg(getPoolConfig(url), { schema });

  const baseClient = new RuntimePrismaClient({
    adapter: baseAdapter,
    errorFormat: 'pretty',
    ...(logQuery ? PRISMA_LOG_OPTIONS : {}),
  }) as unknown as GeneratedPrismaClient;

  if (logQuery) {
    baseClient.$on('query', log);
  }

  if (!replicaUrl) {
    log('Prisma initialized');
    if (shouldReuseClient) {
      globalThis[PRISMA] ??= baseClient;
      return globalThis[PRISMA] as typeof baseClient;
    }

    return baseClient;
  }

  const replicaAdapter = new PrismaPg(getPoolConfig(replicaUrl), { schema });

  const replicaClient = new RuntimePrismaClient({
    adapter: replicaAdapter,
    errorFormat: 'pretty',
    ...(logQuery ? PRISMA_LOG_OPTIONS : {}),
  }) as unknown as GeneratedPrismaClient;

  if (logQuery) {
    replicaClient.$on('query', log);
  }

  const extended = baseClient.$extends(
    readReplicas({
      replicas: [replicaClient],
    }),
  );

  log('Prisma initialized (with replica)');
  if (shouldReuseClient) {
    globalThis[PRISMA] ??= extended;
    return globalThis[PRISMA] as typeof extended;
  }

  return extended;
}

let cachedClient: ReturnType<typeof getClient> | null = null;

function getPrismaClient(): ReturnType<typeof getClient> {
  const shouldReuseClient = !getHyperdriveConnectionString();

  if (!shouldReuseClient) {
    return getClient();
  }

  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = (globalThis[PRISMA] || getClient()) as ReturnType<typeof getClient>;
  return cachedClient;
}
const prisma = {
  get client() {
    return getPrismaClient();
  },
  transaction,
  getAddIntervalQuery,
  getCastColumnQuery,
  getDayDiffQuery,
  getDateSQL,
  getDateWeeklySQL,
  getFilterQuery,
  getSearchParameters,
  getTimestampDiffSQL,
  getSearchSQL,
  pagedQuery,
  pagedRawQuery,
  parseFilters,
  rawQuery,
};

export default prisma;
