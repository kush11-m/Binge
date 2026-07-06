const os = require("os");

function isUsableAddress(address) {
  if (!address || address.internal) return false;
  if (address.family !== "IPv4") return false;
  if (!address.address || address.address === "0.0.0.0") return false;
  return true;
}

function getNetworkUrls({ port, protocol = "http", interfaces = os.networkInterfaces() } = {}) {
  const seen = new Set();
  const urls = [];

  Object.entries(interfaces).forEach(([name, addresses]) => {
    (addresses || []).forEach((address) => {
      if (!isUsableAddress(address)) return;
      const url = `${protocol}://${address.address}:${port}`;
      if (seen.has(url)) return;
      seen.add(url);
      urls.push({
        interface: name,
        address: address.address,
        url
      });
    });
  });

  return urls;
}

module.exports = { getNetworkUrls };
