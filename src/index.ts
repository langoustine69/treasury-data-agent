import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

const TREASURY_BASE = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service';

const agent = await createAgent({
  name: 'treasury-data-agent',
  version: '1.0.0',
  description: 'Real-time US Treasury data: national debt, interest rates, and exchange rates. Powered by official Treasury FiscalData API.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch Treasury data ===
async function fetchTreasury(endpoint: string, params: Record<string, string> = {}) {
  const url = new URL(`${TREASURY_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Treasury API error: ${response.status}`);
  return response.json();
}

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of US Treasury data - current debt, interest rates summary. Try before you buy.',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const [debtData, ratesData] = await Promise.all([
      fetchTreasury('v2/accounting/od/debt_to_penny', { 
        'sort': '-record_date',
        'page[size]': '1'
      }),
      fetchTreasury('v2/accounting/od/avg_interest_rates', {
        'sort': '-record_date',
        'filter': 'security_desc:eq:Total Interest-bearing Debt',
        'page[size]': '1'
      })
    ]);

    const latestDebt = debtData.data?.[0];
    const latestRate = ratesData.data?.[0];

    return {
      output: {
        nationalDebt: {
          total: latestDebt?.tot_pub_debt_out_amt,
          date: latestDebt?.record_date,
          formatted: latestDebt?.tot_pub_debt_out_amt 
            ? `$${(parseFloat(latestDebt.tot_pub_debt_out_amt) / 1e12).toFixed(2)} trillion`
            : null
        },
        interestRate: {
          avgRate: latestRate?.avg_interest_rate_amt,
          date: latestRate?.record_date,
          formatted: latestRate?.avg_interest_rate_amt
            ? `${latestRate.avg_interest_rate_amt}%`
            : null
        },
        dataSource: 'US Treasury FiscalData API (official)',
        fetchedAt: new Date().toISOString(),
        availableEndpoints: ['debt', 'interest-rates', 'exchange-rates', 'compare', 'report']
      }
    };
  },
});

// === PAID ENDPOINT 1: National Debt ($0.001) ===
addEntrypoint({
  key: 'debt',
  description: 'Current US national debt to the penny with historical data',
  input: z.object({
    days: z.number().optional().default(30).describe('Number of days of history (max 365)')
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const limit = Math.min(ctx.input.days, 365);
    const data = await fetchTreasury('v2/accounting/od/debt_to_penny', {
      'sort': '-record_date',
      'page[size]': String(limit)
    });

    const records = data.data?.map((d: any) => ({
      date: d.record_date,
      totalDebt: d.tot_pub_debt_out_amt,
      debtHeldByPublic: d.debt_held_public_amt,
      intragovHoldings: d.intragov_hold_amt,
      fiscalYear: d.record_fiscal_year
    })) || [];

    const latest = records[0];
    const oldest = records[records.length - 1];
    const change = latest && oldest
      ? parseFloat(latest.totalDebt) - parseFloat(oldest.totalDebt)
      : null;

    return {
      output: {
        latest: latest,
        history: records,
        summary: {
          periodDays: records.length,
          changeInPeriod: change ? `$${(change / 1e9).toFixed(2)} billion` : null,
          dailyAvgChange: change && records.length > 1
            ? `$${(change / (records.length - 1) / 1e9).toFixed(2)} billion/day`
            : null
        },
        dataSource: 'US Treasury Debt to the Penny',
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 2: Interest Rates ($0.002) ===
addEntrypoint({
  key: 'interest-rates',
  description: 'Treasury securities interest rates by type (Bills, Notes, Bonds, TIPS)',
  input: z.object({
    securityType: z.enum(['all', 'bills', 'notes', 'bonds', 'tips', 'total']).optional().default('all')
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const filterMap: Record<string, string> = {
      'bills': 'Treasury Bills',
      'notes': 'Treasury Notes',
      'bonds': 'Treasury Bonds',
      'tips': 'Treasury Inflation-Indexed Notes',
      'total': 'Total Interest-bearing Debt'
    };

    let params: Record<string, string> = {
      'sort': '-record_date',
      'page[size]': '50'
    };

    if (ctx.input.securityType !== 'all') {
      params['filter'] = `security_desc:eq:${filterMap[ctx.input.securityType]}`;
    }

    const data = await fetchTreasury('v2/accounting/od/avg_interest_rates', params);

    const records = data.data?.map((d: any) => ({
      date: d.record_date,
      securityType: d.security_type_desc,
      securityDesc: d.security_desc,
      avgInterestRate: d.avg_interest_rate_amt,
      fiscalYear: d.record_fiscal_year
    })) || [];

    // Group by security type for latest values
    const latestByType: Record<string, any> = {};
    records.forEach((r: any) => {
      if (!latestByType[r.securityDesc]) {
        latestByType[r.securityDesc] = r;
      }
    });

    return {
      output: {
        latestRates: Object.values(latestByType),
        history: records.slice(0, 20),
        totalRecords: records.length,
        dataSource: 'US Treasury Average Interest Rates',
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 3: Exchange Rates ($0.002) ===
addEntrypoint({
  key: 'exchange-rates',
  description: 'Treasury exchange rates for world currencies vs USD',
  input: z.object({
    currency: z.string().optional().describe('Filter by country name (e.g., "Canada", "Japan")'),
    limit: z.number().optional().default(50)
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    let params: Record<string, string> = {
      'sort': '-record_date',
      'page[size]': String(Math.min(ctx.input.limit, 200))
    };

    if (ctx.input.currency) {
      params['filter'] = `country:eq:${ctx.input.currency}`;
    }

    const data = await fetchTreasury('v1/accounting/od/rates_of_exchange', params);

    const records = data.data?.map((d: any) => ({
      date: d.record_date,
      country: d.country,
      currency: d.currency,
      exchangeRate: d.exchange_rate,
      effectiveDate: d.effective_date
    })) || [];

    // Get unique latest rates by country
    const latestByCountry: Record<string, any> = {};
    records.forEach((r: any) => {
      const key = `${r.country}-${r.currency}`;
      if (!latestByCountry[key]) {
        latestByCountry[key] = r;
      }
    });

    return {
      output: {
        latestRates: Object.values(latestByCountry),
        totalCurrencies: Object.keys(latestByCountry).length,
        filter: ctx.input.currency || 'all',
        dataSource: 'US Treasury Rates of Exchange',
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 4: Compare Currencies ($0.003) ===
addEntrypoint({
  key: 'compare',
  description: 'Compare exchange rates for multiple countries',
  input: z.object({
    countries: z.array(z.string()).min(2).max(10).describe('Country names to compare (e.g., ["Canada", "Japan", "Germany"])')
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const results = await Promise.all(
      ctx.input.countries.map(async (country) => {
        try {
          const data = await fetchTreasury('v1/accounting/od/rates_of_exchange', {
            'filter': `country:eq:${country}`,
            'sort': '-record_date',
            'page[size]': '5'
          });
          return {
            country,
            found: true,
            rates: data.data?.map((d: any) => ({
              date: d.record_date,
              currency: d.currency,
              exchangeRate: d.exchange_rate
            })) || []
          };
        } catch (e) {
          return { country, found: false, rates: [] };
        }
      })
    );

    // Calculate relative strength (lower rate vs USD = stronger)
    const latestRates = results
      .filter(r => r.found && r.rates.length > 0)
      .map(r => ({
        country: r.country,
        currency: r.rates[0].currency,
        rate: parseFloat(r.rates[0].exchangeRate),
        date: r.rates[0].date
      }))
      .sort((a, b) => a.rate - b.rate);

    return {
      output: {
        comparison: results,
        ranking: latestRates.map((r, i) => ({
          rank: i + 1,
          ...r,
          note: r.rate < 1 ? 'Stronger than USD' : r.rate === 1 ? 'Pegged to USD' : 'Weaker than USD'
        })),
        countriesRequested: ctx.input.countries.length,
        countriesFound: results.filter(r => r.found).length,
        dataSource: 'US Treasury Rates of Exchange',
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 5: Full Report ($0.005) ===
addEntrypoint({
  key: 'report',
  description: 'Comprehensive US Treasury report: debt, rates, and major currency exchange rates',
  input: z.object({
    majorCurrencies: z.boolean().optional().default(true).describe('Include major world currencies')
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const majorCountries = ['Canada', 'Japan', 'United Kingdom', 'Euro Zone', 'China', 'Australia', 'Switzerland'];

    const [debtData, ratesData, ...exchangeData] = await Promise.all([
      fetchTreasury('v2/accounting/od/debt_to_penny', {
        'sort': '-record_date',
        'page[size]': '30'
      }),
      fetchTreasury('v2/accounting/od/avg_interest_rates', {
        'sort': '-record_date',
        'page[size]': '50'
      }),
      ...(ctx.input.majorCurrencies
        ? majorCountries.map(country =>
            fetchTreasury('v1/accounting/od/rates_of_exchange', {
              'filter': `country:eq:${country}`,
              'sort': '-record_date',
              'page[size]': '1'
            }).catch(() => ({ data: [] }))
          )
        : [])
    ]);

    // Process debt
    const latestDebt = debtData.data?.[0];
    const debtHistory = debtData.data?.slice(0, 10).map((d: any) => ({
      date: d.record_date,
      total: d.tot_pub_debt_out_amt
    }));

    // Process interest rates - get latest for each security type
    const ratesByType: Record<string, any> = {};
    ratesData.data?.forEach((d: any) => {
      if (!ratesByType[d.security_desc]) {
        ratesByType[d.security_desc] = {
          type: d.security_desc,
          rate: d.avg_interest_rate_amt,
          date: d.record_date
        };
      }
    });

    // Process exchange rates
    const exchangeRates = ctx.input.majorCurrencies
      ? majorCountries.map((country, i) => {
          const data = exchangeData[i]?.data?.[0];
          return data ? {
            country,
            currency: data.currency,
            rate: data.exchange_rate,
            date: data.record_date
          } : null;
        }).filter(Boolean)
      : [];

    return {
      output: {
        nationalDebt: {
          current: {
            total: latestDebt?.tot_pub_debt_out_amt,
            formatted: latestDebt?.tot_pub_debt_out_amt
              ? `$${(parseFloat(latestDebt.tot_pub_debt_out_amt) / 1e12).toFixed(3)} trillion`
              : null,
            date: latestDebt?.record_date
          },
          recentHistory: debtHistory
        },
        interestRates: {
          bySecurityType: Object.values(ratesByType),
          keyRates: {
            totalDebt: ratesByType['Total Interest-bearing Debt']?.rate,
            treasuryBills: ratesByType['Treasury Bills']?.rate,
            treasuryNotes: ratesByType['Treasury Notes']?.rate,
            treasuryBonds: ratesByType['Treasury Bonds']?.rate
          }
        },
        exchangeRates: {
          majorCurrencies: exchangeRates,
          note: 'Rates are per 1 USD'
        },
        generatedAt: new Date().toISOString(),
        dataSources: [
          'US Treasury Debt to the Penny',
          'US Treasury Average Interest Rates',
          'US Treasury Rates of Exchange'
        ]
      }
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🏛️ Treasury Data Agent running on port ${port}`);

export default { port, fetch: app.fetch };
