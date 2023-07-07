"use strict";

const EventEmitter = require("events");

const fetch = require("node-fetch-commonjs");

//	Class: The `DataCollectorHttpProxy` class implements a transparent proxy for feeding profiling/logging data to an external logging server.
//	Runtime configuration: `DataCollectorHttpProxy` is runtime-configuration-enabled and responds to the following runtime configuration property changes:
//		* "proxy.uri" - `DataCollectorHttpProxy` will forward profiling data by sending HTTP requests to this endpoint.
//		* "proxy.sourceKey" - this key is used by the remote logging server as part of the log file paths allowing for multiple application servers to feed data to a single logging server
//		* "proxy.requestTimeoutMs" - specifies a timeout for HTTP requests before abortion.
//		* "proxy.failureTimeoutMs" - specifies the time between reporting repeated HTTP request failures.
//		* `"buckets.<bucketKey>.enabled"` - specifies explicitly whether the bucket key should be logged or not; `void 0` or `true` mean yes, `false` means no.
//	Events: `DataCollector` emits the following events:
//		* `"configurationChanged"`, arguments: `key, value, oldValue`
//		* `"error"`, arguments: `ncode, message, ex`
//	See also: `DataCollectorServer`.
class DataCollectorHttpProxy extends EventEmitter
{
	//	Constructor: Creates a new instance of the `DataCollectorHttpProxy` class.
	//	Parameter: `par: object` - required.
	//	Parameter: `par.runtimeConfiguration: RuntimeConfiguration` - required; `DataCollectorHttpProxy` subscribes to this instance and listens for runtime configuration changes.
	//	Parameter: `par.fallbackConfiguration: { uri: string, sourceKey: string, requestTimeoutMs: uint, par.failureTimeoutMs: uint }` - required; `DataCollectorHttpProxy` uses the values specified as properties to this object as initial configuration.
	//	Parameter: `par.fallbackConfiguration.uri: string` - required; `DataCollectorHttpProxy` will forward profiling data by sending HTTP requests to this endpoint until overwritten by the runtime configuration.
	//	Parameter: `par.fallbackConfiguration.sourceKey: string` - required; this key is used by the remote logging server as part of the log file paths allowing for multiple application servers to feed data to
	//		a single logging server until overwritten by the runtime configuration.
	//	Parameter: `par.fallbackConfiguration.requestTimeoutMs: uint` - required; specifies a timeout for HTTP requests before abortion until overwritten by the runtime configuration.
	//	Parameter: `par.fallbackConfiguration.failureTimeoutMs: uint` - required; specifies the time between reporting repeated HTTP request failures until overwritten by the runtime configuration.
	constructor(par)
	{
		super();

		this.runtimeConfiguration = par.runtimeConfiguration;
		this.runtimeConfiguration.on("changed", this.runtimeConfiguration_changed.bind(this));
		this.fallbackConfiguration = par.fallbackConfiguration;

		this.uri = par.fallbackConfiguration.uri;
		this.sourceKey = par.fallbackConfiguration.sourceKey;
		this.requestTimeoutMs = par.fallbackConfiguration.requestTimeoutMs;
		this.failureTimeoutMs = par.fallbackConfiguration.failureTimeoutMs;

		this.failureCounter = 0;
		this.failureTime = null;
	}

	//	Function: Fires the "configurationChanged" event whenever a runtime configuration property's value has been changed.
	//	Parameter: `key: string` - the full property object path in the form `propName1.propName2.propName2...`.
	//	Parameter: `value: any` - the new value of the property.
	//	Parameter: `oldValue: any` - the old value of the property; on first configuration read `oldValue` is always undefined.
	onConfigurationChanged(key, value, oldValue)
	{
		this.emit("configurationChanged", key, value, oldValue);
	}

	//	Function: Fires the "error" event whenever a recoverable exception occurs.
	//	Parameter: `ncode: number` - a unique identifier for the codepoint where the error was intercepted.
	//	Parameter: `ex: Error` - the exception instance.
	//	Parameter: `message: string` - additional details about the error.
	onError(ncode, message, ex)
	{
		this.emit("error", ncode, message, ex);
	}

	//	Function: `feed(targetStats: object, hit: object): void` - Transmits the input data to the configured logging server in a non-blocking way.
	//	Parameter: `targetStats: object` - required; the return value of a `ProfilerTarget.getStats()` call (see `ProfilerTarget.getStats` docs for details).
	//	Parameter: `hit: object` - required; the return value of a `ProfilerTarget.hit()` call (see `ProfilerTarget.hit` docs for details).
	//	Remarks: Proxies all incoming data; last-line enabled-state filtering is performed on the remote logging server.
	feed(targetStats, hit)
	{
		if (!this.isBucketEnabled(hit.bucketKey))
		{
			return;
		}

		return setImmediate(() =>
		{
			const start = new Date();
			return _fetchWithTimeout(this.uri,
			{
				method: "POST",
				timeoutMs: this.requestTimeoutMs,
				headers: {
					"Content-Type": 'application/json'
				},
				body: JSON.stringify({
					targetStats,
					hit,
					sourceKey: this.sourceKey,
				}),
			})
			.then(response =>
			{
				if (!response.ok)
				{
					const end = new Date();
					const durationMs = end.getTime() - start.getTime();

					this.failureCounter++;
					if (!this.failureTime || new Date().getTime() - this.failureTime.getTime() >= this.failureTimeoutMs)
					{
						this.failureTime = new Date();
						this.onError(49576324, `${this.failureCounter} feed(s) lost. Failing request took ${durationMs} ms.`, new Error(`HTTP error ${response.status} ${response.statusText}.`));
					}
				}
				response.text().then(body =>
				{
					if (body)
					{
						const end = new Date();
						const durationMs = end.getTime() - start.getTime();

						this.failureCounter++;
						if (!this.failureTime || new Date().getTime() - this.failureTime.getTime() >= this.failureTimeoutMs)
						{
							this.failureTime = new Date();
							this.onError(49576324, `${this.failureCounter} feed(s) lost. Failing request took ${durationMs} ms. Response body was ${JSON.stringify(text)}`, new Error(`Unexpected response error.`));
						}
					}
					else
					{
						if (this.failureCounter)
						{
							this.onError(49576326, `${this.failureCounter} feed(s) were lost. Now resuming normal operation.`);
							this.failureCounter = 0;
						}
					}
				});
			})
			.catch(ex =>
			{
				this.onError(49576327, "HTTP request exception", ex);
			});
		});

		async function _fetchWithTimeout(uri, options)
		{
			const { timeoutMs } = options;

			if (timeoutMs <= 0) return await fetch(uri, options);

			const controller = new AbortController();
			const id = setTimeout(() => controller.abort(), timeoutMs);
			try
			{
				const response = await fetch(uri,
				{
					...options,
					signal: controller.signal
				});
				clearTimeout(id);
				return response;
			}
			catch (ex)
			{
				if (ex.name === "AbortError") throw new Error(`Operation timeout: ${timeoutMs} ms.`);
				else throw ex;
			}
		}
	}

	//	Function: `flush(callback(): void): void` - `DataCollectorHttpProxy` does not collect data that needs to be flushed, hence this method immediately calls `callback` and returns.
	//	Parameter: `callback(err): void` - required; a callback that is called immediately.
	//	Remarks: This method does nothing.
	flush(callback)
	{
		return callback();
	}

	//	Property: Gets the enabled state for the data collector as currently configured by the runtime configuraiton.
	//	Remarks:
	//		Disabling the data collector effectively disables any profiling and logging, except for machine stats collection (see `MachineStats`).
	get enabled()
	{
		this.runtimeConfiguration.asyncSmartRefresh();
		return this.runtimeConfiguration.enabled;
	}

	//	Function: `isBucketEnabled(bucketKey: string)` - gets the enabled state for the specified bucket as currently configured by the runtime configuraiton.
	//	Parameter: `bucketKey: string` - the key of the bucket to test.
	//	Runtime configuration field: `"buckets." + RuntimeConfiguration.escapeConfigurationKeySegment(bucketKey) + ".enabled"`
	//	Remarks: This function ignores the data collector enabled state. The full code to test the effective enabled state of a bucket would be:
	//	```
	//		if (!dataCollector.enabled) return false;
	//		if (!bucketKey) return true;
	//		return dataCollector.isBucketEnabled(bucketKey);
	//	```
	isBucketEnabled(bucketKey)
	{
		this.runtimeConfiguration.asyncSmartRefresh();
		const key = "buckets." + RuntimeConfiguration.escapeConfigurationKeySegment(bucketKey) + ".enabled";
		return this[key] !== false;
	}

	//	Function: Handles runtime configuration changes.
	runtimeConfiguration_changed(key, value, oldValue)
	{
		switch (key)
		{
			case "proxy.uri":
				this.uri = value || this.fallbackConfiguration.uri;
				this.onConfigurationChanged(key, this.uri, oldValue);
				return;
			case "proxy.sourceKey":
				this.sourceKey = value || this.fallbackConfiguration.sourceKey;
				this.onConfigurationChanged(key, this.sourceKey, oldValue);
				return;
			case "proxy.requestTimeoutMs":
				this.requestTimeoutMs = value || this.fallbackConfiguration.requestTimeoutMs;
				this.onConfigurationChanged(key, this.requestTimeoutMs, oldValue);
				return;
			case "proxy.failureTimeoutMs":
				this.failureTimeoutMs = value || this.fallbackConfiguration.failureTimeoutMs;
				this.onConfigurationChanged(key, this.failureTimeoutMs, oldValue);
				return;
		}

		if (key.indexOf("buckets.") === 0)
		{
			this[key] = value;
			this.onConfigurationChanged(key, value, oldValue);
		}
	}
}

module.exports = DataCollectorHttpProxy;
module.exports.DataCollectorHttpProxy = module.exports;
