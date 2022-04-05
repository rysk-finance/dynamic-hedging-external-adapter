const { Requester, Validator } = require("@chainlink/external-adapter");
const { ethers } = require("ethers");
const greeks = require("greeks");
const lpContractInfo = require("../artifacts/LiquidityPool.json");
const optionRegistryContractInfo = require("../artifacts/OptionRegistryV2.json");
const conversionHelpers = require("./utils");

const LiquidityPoolABI = lpContractInfo.abi;
const OptionRegistryABI = optionRegistryContractInfo.abi;

const { genOptionTimeFromUnix, fromWei } = conversionHelpers;
// Define custom error scenarios for the API.
// Return true for the adapter to retry.
const customError = (data) => {
  if (data.Response === "Error") return true;
  return false;
};

// Define custom parameters to be used by the adapter.
// Extra parameters can be stated in the extra object,
// with a Boolean value indicating whether or not they
// should be required.
const customParams = {};

const createRequest = async (input, callback) => {
  // The Validator helps you validate the Chainlink request data
  const validator = new Validator(callback, input, customParams);
  const jobRunID = validator.validated.id;

  // web3 config vars
  const network = process.env.NETWORK;
  const apiKey = process.env.API_KEY;
  const lpAddress = process.env.LP_ADDRESS;
  const optionRegistryAddress = process.env.OPTION_REGISTRY_ADDRESS;
  // setup web3
  const provider = new ethers.providers.AlchemyProvider(network, apiKey);
  const liquidityPool = new ethers.Contract(
    lpAddress,
    LiquidityPoolABI,
    provider
  );
  const optionRegistry = new ethers.Contract(
    optionRegistryAddress,
    OptionRegistryABI,
    provider
  );

  const events = liquidityPool.filters.WriteOption();
  const writeOption = await liquidityPool.queryFilter(events);
  const blockNum = await ethers.provider.getBlockNumber();
  const block = await ethers.provider.getBlock(blockNum);
  const rfr = await liquidityPool.riskFreeRate();
  const { timestamp } = block;
  // TODO consider using local DB to speed up queries and make less calls
  // Are there restrictions on localstorage on chainlink nodes or adapters?
  const enrichedWriteOptions = writeOption.map(async (x) => {
    const { data, topics, decode } = x;
    if (!decode) return x;
    x.decoded = decode(data, topics);
    x.series = x.decoded.series;
    //@TODO consider batching these as a multicall or using an index service and checking localStorage first
    const seriesInfo = await optionRegistry.seriesInfo(x.series);
    const priceQuote = await priceFeed.getNormalizedRate(
      seriesInfo.underlying,
      seriesInfo.strikeAsset
    );
    const priceNorm = fromWei(priceQuote);
    const iv = await liquidityPool.getImpliedVolatility(
      seriesInfo.isPut,
      priceQuote,
      seriesInfo.strike,
      seriesInfo.expiration
    );
    const optionType = seriesInfo.isPut ? "put" : "call";
    const timeToExpiration = genOptionTimeFromUnix(
      Number(timestamp),
      seriesInfo.expiration
    );
    const delta = greeks.getDelta(
      priceNorm,
      fromWei(seriesInfo.strike),
      timeToExpiration,
      fromWei(iv),
      parseFloat(rfr),
      optionType
    );
    // invert sign due to writing rather than buying
    x.delta = delta * -1;
    return x;
  });
  const resolvedEnriched = await Promise.all(enrichedWriteOptions);
  const portfolioDelta = resolvedEnriched.reduce(
    (partial, a) => partial + a,
    0
  );

  callback(200, {
    id: jobRunID,
    data: { portfolioDelta },
  });
  // The Requester allows API calls be retry in case of timeout
  // or connection failure
  // should we implement our own version of this or can it be used with ethers contracts directly?
  // Requester.request(config, customError)
  //   .then(response => {
  //     // It's common practice to store the desired value at the top-level
  //     // result key. This allows different adapters to be compatible with
  //     // one another.
  //     response.data.result = Requester.validateResultNumber(response.data, [tsyms])
  //     callback(response.status, Requester.success(jobRunID, response))
  //   })
  //   .catch(error => {
  //     callback(500, Requester.errored(jobRunID, error))
  //   })
};

// This is a wrapper to allow the function to work with
// GCP Functions
exports.gcpservice = (req, res) => {
  createRequest(req.body, (statusCode, data) => {
    res.status(statusCode).send(data);
  });
};

// This is a wrapper to allow the function to work with
// AWS Lambda
exports.handler = (event, context, callback) => {
  createRequest(event, (statusCode, data) => {
    callback(null, data);
  });
};

// This is a wrapper to allow the function to work with
// newer AWS Lambda implementations
exports.handlerv2 = (event, context, callback) => {
  createRequest(JSON.parse(event.body), (statusCode, data) => {
    callback(null, {
      statusCode: statusCode,
      body: JSON.stringify(data),
      isBase64Encoded: false,
    });
  });
};

// This allows the function to be exported for testing
// or for running in express
module.exports.createRequest = createRequest;
