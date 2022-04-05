const { ethers } = require("ethers");
const { utils } = ethers

const SECONDS_IN_DAY = 86400
const SECONDS_IN_YEAR = SECONDS_IN_DAY * 365.25
const genOptionTimeFromUnix = (now, future) =>
      (future - now) / SECONDS_IN_YEAR
const fromWei = (x) => utils.formatEther(x)
module.exports = {
  genOptionTimeFromUnix,
  fromWei
}
