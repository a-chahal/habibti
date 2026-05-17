# habibti

agent-native trade infrastructure for the long tail of importers.

## the agent layer

every shipment runs through a directed graph of small specialist agents.
each one owns a single decision — what to buy, where to ship from, what
could go wrong — and publishes a typed signal the next agent reads. the
orchestrator fans out 30+ dispatches per shipment and synthesises them
into three ranked options. there is no single big model "doing sourcing";
there is a swarm of mercury-2 agents, each cheap enough to spawn dozens at
a time.

the result is the same trade intelligence a global freight forwarder has
on tap — surfaced for a single buyer of cinnamon, lithium cells, or
denim. one importer plugged into the same global trade fabric the top
0.1% already operate inside.

## the agents

sourcing pipeline:

    intent-parser         natural language → structured intent
    country-discoverer    un comtrade volumes, sanctions pre-filter
    tariff-calculator     federal register ustr + freight math
    compliance-screener   ofac sdn + uflpa entity matching
    supplier-verifier     gleif lei / uk companies house
    country-risk          gdelt 30-day news window per origin
    port-discoverer       picks top 3 ports per country from un/locode
    route-planner         pure-code graph search through 14 maritime gates
    leg-analyzer          per-leg gdelt 14d+90d anomaly, wave height vs
                          climatology, ais traffic density, jwla war-risk
                          zones, seasonal hazards, bunker fuel cost
    freight-pricer        distance × rate + canal tolls + baf + war-risk
    product-pricer        comtrade unit values × quantity
    option-ranker         mercury reasons over the final three

post-confirmation monitoring:

    vessel-tracker · port-congestion · corridor-news · weather-hazard ·
    regulatory-watcher · synthesizer

## quick start

    npm install
    npm run db:up
    npm run db:push
    npm run load-sanctions
    npm run dev

open `http://localhost:3000` and try

    500 lithium batteries from china to la by aug 30, $80k

## connecting the world

the chokepoints registry covers suez, panama, malacca, hormuz, gibraltar,
bab-el-mandeb, bosphorus, kiel, sunda, torres, taiwan strait, cape of good
hope, cape horn. 13 ocean basins with explicit open-water adjacency force
a shanghai→rotterdam route to physically traverse malacca + suez +
gibraltar instead of cutting through asia. port resolution is a three-tier
chain: a curated dict for major hubs, the full un/locode table, and
mercury as a last-resort resolver — cached forever after the first hit.

## architecture

    /lib
      /agents     base class + specialist agents
      /routing    chokepoints, basins, geometry, route-planner,
                  war-risk zones, seasonal hazards
      /sources    gdelt, comtrade, aisstream, openmeteo, ustr, gleif,
                  companies-house, bunker, locations, sanctions
      /db         drizzle schema + queries
      /llm        openrouter client (mercury-2 by default)
      /events     in-process pub/sub
      /cache      lru + postgres two-tier
    /app          next.js 14 app router + api routes
    /components   three.js globe, agent panel, route detail
    /scripts      load / test / verify utilities

## env

    DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trade_platform
    OPENROUTER_API_KEY=
    AISSTREAM_API_KEY=
    UK_COMPANIES_HOUSE_API_KEY=

no key needed for gdelt, comtrade, federal register, gleif, open-meteo,
ofac sdn, uflpa.

## stack

next.js 14 · typescript · drizzle · postgres 16 · tailwind · framer motion
· three.js · openrouter mercury-2 · eventemitter3
