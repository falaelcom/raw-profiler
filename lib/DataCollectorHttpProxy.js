"use strict";

const EventEmitter = require("events");

const RuntimeConfigurator = require("./RuntimeConfigurator");

const fetch = require("node-fetch-commonjs");

//	Class: The `DataCollectorHttpProxy` class implements a transparent proxy for feeding profiling/logging data to an external logging server.
//	Runtime configuration: `DataCollectorHttpProxy` is runtime-configuration-enabled and responds to the following runtime configuration property changes:
//		* "proxy.uri" - `DataCollectorHttpProxy` will forward profiling data by sending HTTP requests to this URI.
//		* "proxy.sourceKey" - this key is used by the remote logging server as part of the log file paths allowing for multiple application servers to feed data to a single logging server
//		* "proxy.requestTimeoutMs" - specifies a timeout for HTTP requests before abortion.
//		* "proxy.failureTimeoutMs" - specifies the time between reporting repeated HTTP request failures.
//		* `"buckets.<bucketKey>.enabled"` - specifies explicitly whether the bucket key should be logged or not; `void 0` or `true` mean yes, `false` means no.
//	Events: `DataCollector` emits the following events:
//		* `"info"`, arguments: `message`
//		* `"error"`, arguments: `ncode, message, ex`
//		* `"configurationChanged"`, arguments: `key, value, oldValue, source, ctimes`
//	See also: `DataCollectorServer`.
class DataCollectorHttpProxy extends EventEmitter
{
	//	Constructor: Creates a new instance of the `DataCollectorHttpProxy` class.
	//	Parameter: `par: object` - required.
	//	Parameter: `par.runtimeConfigurator: RuntimeConfigurator | RemoteRuntimeConfigurator` - required; `DataCollectorHttpProxy` subscribes to this instance and listens for runtime configuration changes.
	//	Parameter: `par.runtimeInitial: { uri: string, sourceKey: string, requestTimeoutMs: uint, par.failureTimeoutMs: uint, "buckets.*"... }` - required; `DataCollectorHttpProxy` uses the values specified as properties to this object as initial configuration.
	//	Parameter: `par.runtimeInitial["buckets.*"]: *` - optional; a mechanism to specify initial/default values foir the buckets runtime configuration that is loaded later from `__pfconfig`.
	//	Parameter: `par.runtimeInitial.uri: string` - required; `DataCollectorHttpProxy` will forward profiling data by sending HTTP requests to this URI until overwritten by the runtime configuration.
	//	Parameter: `par.runtimeInitial.sourceKey: string` - required; this key is used by the remote logging server as part of the log file paths allowing for multiple application servers to feed data to
	//		a single logging server until overwritten by the runtime configuration.
	//	Parameter: `par.runtimeInitial.requestTimeoutMs: uint` - required; specifies a timeout for HTTP requests before abortion until overwritten by the runtime configuration.
	//	Parameter: `par.runtimeInitial.failureTimeoutMs: uint` - required; specifies the time between reporting repeated HTTP request failures until overwritten by the runtime configuration.
	constructor(par)
	{
		super();

		this.runtimeConfigurator = par.runtimeConfigurator;
		this.runtimeConfigurator.on("changed", this.runtimeConfiguration_changed.bind(this));
		this.runtimeInitial = par.runtimeInitial;

		this.uri = par.runtimeInitial.uri;
		this.sourceKey = par.runtimeInitial.sourceKey;
		this.requestTimeoutMs = par.runtimeInitial.requestTimeoutMs;
		this.failureTimeoutMs = par.runtimeInitial.failureTimeoutMs;
		for (const key in this.runtimeInitial) if (key.indexOf("buckets.") === 0) this[key] = this.runtimeInitial[key];

		this.failureCounter = 0;
		this.failureTime = null;
		this.remoteConfigPollingTimer = null;
	}

	//	Function: Fires the "configurationChanged" event whenever a runtime configuration property's value has been changed.
	//	Parameter: `key: string` - the full property object path in the form `propName1.propName2.propName2...`.
	//	Parameter: `value: any` - the new value of the property.
	//	Parameter: `oldValue: any` - the old value of the property; on first configuration read `oldValue` is always undefined.
	//	Parameter: `source: string` - indicates the source for the update of ths setting (see `RuntimeConfigurator.onChanged`, `RemoteRuntimeConfigurator.onChanged`).
	//	Parameter: `ctimes: { commandFile: uint | null, configurationFile: uint | null } | void 0` - optional; `null` times mean the corresponding file could not be accessed for whatever reason; not set with `source === "prop"`.
	onConfigurationChanged(key, value, oldValue, source, ctimes)
	{
		this.emit("configurationChanged", key, value, oldValue, source, ctimes);
	}

	//	Function: Fires the "info" event whenever operation information is available.
	//	Parameter: `message: string` - additional details about the error.
	onInfo(message)
	{
		this.emit("info", message);
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
			const body =
			{
				targetStats,
				hit,
				sourceKey: this.sourceKey,
			};
			this.runtimeConfigurator.inspectFeedBody(body);
			const bodyJson = JSON.stringify(body);
			return DataCollectorHttpProxy.fetchWithTimeout(this.uri.replace(/\/+$/, "") + "/feed",
			{
				method: "POST",
				timeoutMs: this.requestTimeoutMs,
				headers: {
					"Content-Type": 'application/json'
				},
				body: bodyJson,
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
					if (this.runtimeConfigurator.useRemoteConfig)
					{
						try
						{
							this.runtimeConfigurator.inspectFeedResponse(body, response).catch(ex => { throw ex });	//	it's alright not to await here; the response inspection does either nothing or triggers configuration updates and forgets
							if (this.failureCounter)
							{
								this.onInfo(`${this.failureCounter} feed(s) were lost. Now resuming normal operation.`);
								this.failureCounter = 0;
								this.failureTime = null;
							}
						}
						catch (ex)
						{ 
							const end = new Date();
							const durationMs = end.getTime() - start.getTime();

							this.failureCounter++;
							if (!this.failureTime || new Date().getTime() - this.failureTime.getTime() >= this.failureTimeoutMs)
							{
								this.failureTime = new Date();
								this.onError(49576329, `${this.failureCounter} feed(s) lost. Failing request took ${durationMs} ms. Response body was ${JSON.stringify(body)}`, ex);
							}
						}
						return;
					}
					if (body || response.status !== 204)
					{
						const end = new Date();
						const durationMs = end.getTime() - start.getTime();

						this.failureCounter++;
						if (!this.failureTime || new Date().getTime() - this.failureTime.getTime() >= this.failureTimeoutMs)
						{
							this.failureTime = new Date();
							this.onError(49576324, `${this.failureCounter} feed(s) lost. Failing request took ${durationMs} ms. Response body was ${JSON.stringify(body)}`, new Error(`Unexpected response error (status code ${response.status}, body length: ${body.length}).`));
						}
					}
					else
					{
						if (this.failureCounter)
						{
							this.onInfo(`${this.failureCounter} feed(s) were lost. Now resuming normal operation.`);
							this.failureCounter = 0;
							this.failureTime = null;
						}
					}
				});
			})
			.catch(ex =>
			{
				if (ex instanceof fetch.FetchError)
				{
					const end = new Date();
					const durationMs = end.getTime() - start.getTime();

					this.failureCounter++;
					if (!this.failureTime || new Date().getTime() - this.failureTime.getTime() >= this.failureTimeoutMs)
					{
						this.failureTime = new Date();
						this.onError(49576328, `${this.failureCounter} feed(s) lost. Failing request took ${durationMs} ms.`, ex);
					}
				}
				else this.onError(49576327, "HTTP request exception", ex);
			});
		});
	}

	//	Function: `flush(callback(): void): void` - `DataCollectorHttpProxy` does not collect data that needs to be flushed, hence this method immediately calls `callback` and returns.
	//	Parameter: `callback(err): void` - required; a callback that is called immediately.
	//	Remarks: This method does nothing.
	flush(callback)
	{
		return callback?.();
	}

	async requestRemoteConfig()
	{
		if (!this.runtimeConfigurator.useRemoteConfig) throw new Error(`Invalid operation.`);

		while (true)
		{
			const body = {};
			this.runtimeConfigurator.inspectFeedBody(body);
			const bodyJson = JSON.stringify(body);
			try
			{
				const response = await DataCollectorHttpProxy.fetchWithTimeout(this.uri.replace(/\/+$/, "") + "/conf",
				{
					method: "POST",
					timeoutMs: this.runtimeConfigurator.remoteConfigRequestTimeoutMs,
					headers: {
						"Content-Type": 'application/json'
					},
					body: bodyJson,
				});
				if (!response.ok) throw new fetch.FetchError(`Unexpected response status code: ${response.status}.`, "system");
				const responseBody = await response.text();
				await this.runtimeConfigurator.inspectFeedResponse(responseBody, response);
				return;
			}
			catch (ex)
			{
				this.onError(79576321, "HTTP request exception", ex);
			}
			await DataCollectorHttpProxy.sleep(this.runtimeConfigurator.repeatOnRemoteConfigFailureIntervalMs);
		}
	}

	//	Function: `getConfigurationLines(prefix: string): [{ setting: string, type: string, value: *, explanation: string | undefined }]` - lists all configuration settings relevant for this instance.
	//	Parameter: `prefix: string` - optional, defaults to null; if not `null`, `undefined` or `""`, the prefix followed by a period is prepended to all setting names.
	//	Returns: A lists all configuration settings relevant for this instance, e.g.
	//	```
	//	//	with prefix === `dataCollectorHttpProxy`
	//	{
	//		{ setting: "dataCollectorHttpProxy.type", type: "preconf", value: "DataCollectorHttpProxy" },
	//		{ setting: "dataCollectorHttpProxy.enabled", type: "runtime", value: true },
	//		{ setting: "dataCollectorHttpProxy.uri", type: "runtime", value: "http://localhost:8081" },
	//		{ setting: "dataCollectorHttpProxy.sourceKey", type: "runtime", value: "node1" },
	//		{ setting: "dataCollectorHttpProxy.requestTimeoutMs", type: "runtime", value: 5000 },
	//		{ setting: "dataCollectorHttpProxy.failureTimeoutMs", type: "runtime", value: 60000 },
	//		{ setting: "dataCollectorHttpProxy.buckets.DB.verbosity", type: "runtime", value: "brief" },
	//	}
	//	```
	getConfigurationLines(prefix = null)
	{
		const fp = prefix ? `${prefix}.` : "";
		let result = [];
		result.push({ setting: fp + "type", type: "preconf", value: "DataCollectorHttpProxy" });
		result.push({ setting: fp + "enabled", type: "runtime", value: this.enabled });
		result.push({ setting: fp + "uri", type: "runtime", value: this.uri });
		result.push({ setting: fp + "sourceKey", type: "runtime", value: this.sourceKey });
		result.push({ setting: fp + "requestTimeoutMs", type: "runtime", value: this.requestTimeoutMs });
		result.push({ setting: fp + "failureTimeoutMs", type: "runtime", value: this.failureTimeoutMs });
		for (const key in this) if (key.indexOf("buckets.") === 0) result.push({ setting: fp + key, type: "runtime", value: this[key] });
		return result;
	}

	//	Property: Gets the enabled state for the data collector as currently configured by the runtime configuraiton.
	//	Remarks:
	//		Disabling the data collector effectively disables any profiling and logging, except for machine stats collection (see `MachineStats`).
	get enabled()
	{
		this.runtimeConfigurator.asyncSmartRefresh();
		return this.runtimeConfigurator.enabled;
	}

	//	Function: `isBucketEnabled(bucketKey: string)` - gets the enabled state for the specified bucket as currently configured by the runtime configuraiton.
	//	Parameter: `bucketKey: string` - the key of the bucket to test.
	//	Runtime configuration field: `"buckets." + RuntimeConfigurator.escapeConfigurationKeySegment(bucketKey) + ".enabled"`
	//	Remarks: This function ignores the data collector enabled state. The full code to test the effective enabled state of a bucket would be:
	//	```
	//		if (!dataCollector.enabled) return false;
	//		if (!bucketKey) return true;
	//		return dataCollector.isBucketEnabled(bucketKey);
	//	```
	isBucketEnabled(bucketKey)
	{
		this.runtimeConfigurator.asyncSmartRefresh();
		const key = "buckets." + RuntimeConfigurator.escapeConfigurationKeySegment(bucketKey) + ".enabled";
		return this[key] !== false;
	}

	//	Function: Handles runtime configuration changes.
	//	Remarks: Keep in sync with `DataCollectorHttpProxy.runtimeConfiguration_changed`!
	runtimeConfiguration_changed(key, value, oldValue, source, ctimes)
	{
		if (this.runtimeConfigurator.useRemoteConfig && key === "enabled")
		{
			if (value && this.remoteConfigPollingTimer) this._stopRemoteConfigPollingMode();
			else if (!value && !this.remoteConfigPollingTimer) this._startRemoteConfigPollingMode();
		}

		switch (key)
		{
			case "proxy.uri":
				this.uri = value || this.runtimeInitial.uri;
				this.onConfigurationChanged(key, this.uri, oldValue, source, ctimes);
				return;
			case "proxy.sourceKey":
				this.sourceKey = value || this.runtimeInitial.sourceKey;
				this.onConfigurationChanged(key, this.sourceKey, oldValue, source, ctimes);
				return;
			case "proxy.requestTimeoutMs":
				this.requestTimeoutMs = value || this.runtimeInitial.requestTimeoutMs;
				this.onConfigurationChanged(key, this.requestTimeoutMs, oldValue, source, ctimes);
				return;
			case "proxy.failureTimeoutMs":
				this.failureTimeoutMs = value || this.runtimeInitial.failureTimeoutMs;
				this.onConfigurationChanged(key, this.failureTimeoutMs, oldValue, source, ctimes);
				return;
		}

		if (key.indexOf("buckets.") === 0)
		{
			this[key] = value;
			this.onConfigurationChanged(key, value, oldValue, source, ctimes);
		}
	}

	_startRemoteConfigPollingMode()
	{
		if (!this.runtimeConfigurator.useRemoteConfig) throw new Error(`Invalid operation.`);
		if (this.remoteConfigPollingTimer) throw new Error(`Invalid operation.`);
		let busy = false;
		this.remoteConfigPollingTimer = setInterval(async () =>
		{
			if (busy) return;
			busy = true;
			try
			{
				const response = await DataCollectorHttpProxy.fetchWithTimeout(this.uri.replace(/\/+$/, "") + "/e",
				{
					method: "GET",
					timeoutMs: this.runtimeConfigurator.remoteConfigRequestTimeoutMs,
				});
				if (!response.ok) throw new fetch.FetchError(`Unexpected response status code: ${response.status}.`, "system");
				await this.runtimeConfigurator.inspectConfigPollingResponse(response);
			}
			catch (ex)
			{
				this.onError(79576325, "HTTP request exception", ex);
				await DataCollectorHttpProxy.sleep(this.failureTimeoutMs);
			}
			finally
			{
				busy = false;
			}
		}, this.runtimeConfigurator.remoteConfigPollingIntervalMs);
	}

	_stopRemoteConfigPollingMode()
	{
		if (!this.runtimeConfigurator.useRemoteConfig) throw new Error(`Invalid operation.`);
		if (!this.remoteConfigPollingTimer) throw new Error(`Invalid operation.`);
		clearInterval(this.remoteConfigPollingTimer);
		this.remoteConfigPollingTimer = null;
	}

	static async fetchWithTimeout(uri, options)
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
			if (ex.name === "AbortError") throw new fetch.FetchError(`Operation timeout: ${timeoutMs} ms.`, "system", ex);
			else throw ex;
		}
	}

	static async sleep(ms)
	{
		return new Promise(f => setTimeout(f, ms));
	}
}

module.exports = DataCollectorHttpProxy;
module.exports.DataCollectorHttpProxy = module.exports;
