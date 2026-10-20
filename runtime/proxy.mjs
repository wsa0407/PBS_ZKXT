// Child-process network setup; never changes the parent application's dispatcher.
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
