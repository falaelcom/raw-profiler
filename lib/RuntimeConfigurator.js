"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const async = require("async");

const EventEmitter = require("events");
class AsyncEventEmitter extends EventEmitter
{
	async emitAsync(eventName, ...args)
	{
		const listeners = this.listeners(eventName);
		for (let listener of listeners)
		{
			await listener(...args);
		}
	}
}

const RC_SIGNAL_OK = 1;
const RC_SIGNAL_DISABLED = 2;
const RC_SIGNAL_UNCONFIGURED = 3;
const RC_SIGNAL_UNCHANGED = 4;
const RC_SIGNAL_EMPTY_DATA = 5;
const RC_SIGNAL_BAD_DATA = 6;
const RC_SIGNAL_ERROR = 7;

//	Class: Facilitates asynchronous reloading of configuration data at runtime.
//	Events: `ConsoleLogger` emits the following events:
//		* `"changed"`, arguments: `key, value, oldValue`
//		* `"refreshFinished"`, arguments: `hasChanged: boolean`
//	Remarks: Only supports numeric, string and boolean configuration values.
class RuntimeConfigurator extends AsyncEventEmitter
{
	//	Parameter: `par: {commandFilePath, configurationFilePath, refreshSilenceTimeoutMs}`.
	//	Parameter: `par.commandFilePath: string` - required; the full path to the runtime command file for `raw-profiler`, e.g. `/home/user/__pfenable`; the existance of the command file
	//		determines the enabled state of the `raw-profiler`; if there is no such file, the `raw-profiler` functionality is completely disabled except for testing for the command file existence.
	//	Parameter: `par.configurationFilePath: string` - required; the full path to the runtime configuration file for `raw-profiler`, e.g. `/home/user/__pfconfig`.
	//	Parameter: `par.refreshSilenceTimeoutMs: uint` - defaults to `5000`; run-time configuration refresh-from-file attempts will be performed no more frequently than 
	//		once every `refreshSilenceTimeoutMs` milliseconds.
	//	Parameter: `par.initialEnabled: boolean` - defaults to `true`; provides an initial value for the profiler enabled state before the command file has been queried for the first time.
	//	Remarks: 
	//		Only supports numeric, string and boolean configuration values.
	//		Subscribe for the `changed` event to listen for runtime configuration changes: `new RuntimeConfigurator({...}).on("changed", (key, value, oldValue) => {...})`.
	constructor(par)
	{
		super();

		if (!par) throw new Error(`Argument is null: "par".`);
		if (!par.configurationFilePath) throw new Error(`Argument is null: "par.configurationFilePath".`);
		if (!par.commandFilePath) throw new Error(`Argument is null: "par.commandFilePath".`);
		if (par.refreshSilenceTimeoutMs === void 0 || par.refreshSilenceTimeoutMs === null) throw new TypeError(`Argument is null: "par.refreshSilenceTimeoutMs".`);
		if (isNaN(par.refreshSilenceTimeoutMs)) throw new TypeError(`Type mismatch: "par.refreshSilenceTimeoutMs" (1).`);
		if (Math.floor(par.refreshSilenceTimeoutMs) !== par.refreshSilenceTimeoutMs) throw new TypeError(`Type mismatch: "par.refreshSilenceTimeoutMs" (2).`);
		if (par.refreshSilenceTimeoutMs < 0) throw new Error(`Value out of range: "par.refreshSilenceTimeoutMs".`);
		if (par.initialEnabled !== void 0 && par.initialEnabled !== true && par.initialEnabled !== false) throw new TypeError(`Type mismatch: "par.initialEnabled".`);

		this.commandFilePath = par.commandFilePath;
		this.configurationFilePath = par.configurationFilePath;
		this.refreshSilenceTimeoutMs = par.refreshSilenceTimeoutMs;
		this.enabled = par.initialEnabled !== false;

		this.isRefreshing = false;
		this.lastRefreshTime = null;
		this.validFileChangedTime = null;
		this.data = {};
	}

	//	Function: Fires the "changed" event whenever a runtime configuration property's value has been changed.
	//	Parameter: `key: string` - the full property object path in the form `propName1.propName2.propName2...`.
	//	Parameter: `value: any` - the new value of the property.
	//	Parameter: `oldValue: any` - the old value of the property; on first configuration read `oldValue` is always undefined.
	//	Remarks: This event is fired for the first time on the configuration first read only for runtime congiguration properties that are not undefined.
	async onChanged(key, value, oldValue)
	{
		await this.emitAsync("changed", key, value, oldValue);
	}

	//	Function: Fires the "changed" event whenever a runtime configuration property's value has been changed.
	//	Parameter: `key: string` - the full property object path in the form `propName1.propName2.propName2...`.
	//	Parameter: `value: any` - the new value of the property.
	//	Parameter: `oldValue: any` - the old value of the property; on first configuration read `oldValue` is always undefined.
	//	Remarks: This event is fired for the first time on the configuration first read only for runtime congiguration properties that are not undefined.
	onRefreshFinished(hasChanged)
	{
		this.emit("refreshFinished", hasChanged);
	}

	//	Function: Refreshes the runtime configuraiton if `this.refreshSilenceTimeoutMs` milliseconds ahve been elapsed since the last refresh.
	asyncSmartRefresh(callback)
	{
		if (this.isRefreshing) return callback?.(false);
		if (this.lastRefreshTime && new Date().getTime() - this.lastRefreshTime.getTime() < this.refreshSilenceTimeoutMs) return callback?.(false);

		this.isRefreshing = true;

		return this._reload(function (signal, result)
		{
			this.lastRefreshTime = new Date();
			this.isRefreshing = false;

			switch (signal)
			{
				case RC_SIGNAL_OK:
				case RC_SIGNAL_UNCONFIGURED:
				case RC_SIGNAL_EMPTY_DATA:
				case RC_SIGNAL_UNCHANGED:
				case RC_SIGNAL_BAD_DATA:
				case RC_SIGNAL_ERROR:
					if (!this.enabled)
					{
						this.enabled = true;
						console.log("[raw-profiler]", "Enabled is now set to:", this.enabled);
						this.onRefreshFinished(true);
					}
					else this.onRefreshFinished(result.hasChanged);
					break;
				case RC_SIGNAL_DISABLED:
					if (this.enabled)
					{
						this.enabled = false;
						console.log("[raw-profiler]", "Enabled is now set to:", this.enabled);
						this.onRefreshFinished(true);
					}
					else this.onRefreshFinished(result.hasChanged);
					break;
				default: throw new Error(`Not implemented.`);
			}
			return callback?.(true);
		}.bind(this));
	}

	//	Function: `	getConfigurationLines(prefix: string): [{ setting: string, type: string, value: *, explanation: string | undefined }]` - lists all configuration settings relevant for this instance.
	//	Parameter: `prefix: string` - optional, defaults to null; if not `null`, `undefined` or `""`, the prefix followed by a period is prepended to all setting names.
	//	Returns: A lists all configuration settings relevant for this instance, e.g.
	//	```
	//	//	with prefix === `runtimeConfigurator`
	//	{
	//		{ setting: "runtimeConfigurator.commandFilePath", type: "preconf", value: "/var/__pfenabled.custom" },
	//		{ setting: "runtimeConfigurator.configurationFilePath", type: "preconf", value: "/var/__pfconfig.custom" },
	//		{ setting: "runtimeConfigurator.refreshSilenceTimeoutMs", type: "preconf", value: 5000 },
	//	}
	//	```
	getConfigurationLines(prefix = null)
	{
		const fp = prefix ? `${prefix}.` : "";
		let result = [];

		result.push({ setting: fp + "commandFilePath", type: "preconf", value: this.commandFileFullPath });
		result.push({ setting: fp + "configurationFilePath", type: "preconf", value: this.configurationFileFullPath });
		result.push({ setting: fp + "refreshSilenceTimeoutMs", type: "preconf", value: this.refreshSilenceTimeoutMs });

		return result;
	}

	_reload(callback)
	{
		let stats;
		let json;
		return async.waterfall(
		[
			function (next)
			{
				return fs.stat(this.commandFileFullPath, function (err, stats)
				{
					if (err)
					{
						return next(RC_SIGNAL_DISABLED);
					}
					return next(null, stats);
				});
			}.bind(this),
			function (result, next)
			{
				return fs.stat(this.configurationFileFullPath, function (err, stats)
				{
					if (err)
					{
						return next(RC_SIGNAL_UNCONFIGURED);
					}
					return next(null, stats);
				});
			}.bind(this),
			function (result, next)
			{
				stats = result;
				if (this.validFileChangedTime && stats.mtime.getTime() == this.validFileChangedTime.getTime())
				{
					return next(RC_SIGNAL_UNCHANGED);
				}

				return fs.readFile(this.configurationFileFullPath, "utf8", next);
			}.bind(this),
			function (result, next)
			{
				json = result;
				this.validFileChangedTime = stats.mtime;

				if (!json || !json.trim || !json.trim())
				{
					//  no valid configuration data
					return next(RC_SIGNAL_EMPTY_DATA);
				}

				try
				{
					return this._readConfigurationData(JSON.parse(json)).then(outcome => next(null, { hasChanged: outcome }));
				}
				catch (ex)
				{
					console.log(236851, "[raw-profiler]", "Error in runtime configuration JSON (file path \"" + this.configurationFileFullPath + "\"): ", ex);
					return next(RC_SIGNAL_BAD_DATA);
				}

			}.bind(this),
		], function (signal, result)
		{
			switch (signal)
			{
				case null:
					return callback(RC_SIGNAL_OK, result);
				case RC_SIGNAL_DISABLED:
				case RC_SIGNAL_UNCHANGED:
				case RC_SIGNAL_BAD_DATA:
					return callback(signal, { hasChanged: false});
				case RC_SIGNAL_UNCONFIGURED:
				case RC_SIGNAL_EMPTY_DATA:
					return this._readConfigurationData({}).then(outcome => callback(signal, outcome));
				default:
					console.log(2368501, "[raw-profiler]", "Error reading the runtime configuration JSON (file path \"" + this.configurationFileFullPath + "\"): ", signal);
					return callback(RC_SIGNAL_ERROR, { hasChanged: false });
			}
		}.bind(this));
	}

	//	Remarks: Only supports numeric, string and boolean configuration values.
	async _readConfigurationData(data)
	{
		async function __traverse(obj, visit, prefix = "")
		{
			for (const key in obj)
			{
				const value = obj[key];
				const path = prefix + RuntimeConfigurator.escapeConfigurationKeySegment(key);
				if (value === 0 || (value && value.constructor === Number)) await visit(path, value);
				else if (value === "" || (value && value.constructor === String)) await visit(path, value);
				else if (value === true || value === false || (value && value.constructor === Boolean)) await visit(path, value);
				else await __traverse(value, visit, path + '.');
			}
		}

		let hasChanged = false;
		const keySet = new Set();
		await __traverse(data, async (path, value) =>
		{
			keySet.add(path);
			const oldValue = this.data[path];
			if (oldValue === value) return;
			try
			{
				hasChanged = true;
				await this.onChanged(path, value, oldValue);
			}
			catch (ex)
			{
				console.error(2368502, "[raw-profiler]", "The RuntimeConfigurator.prototype.changed callback has thrown an exception", ex);
			}
			this.data[path] = value;
		});

		for (const path in this.data)
		{
			const value = this.data[path];
			if (keySet.has(path)) continue;
			if (value === void 0) continue;
			try
			{
				hasChanged = true;
				await this.onChanged(path, void 0, value);
			}
			catch (ex)
			{
				console.error(2368503, "[raw-profiler]", "The RuntimeConfigurator.prototype.changed callback has thrown an exception", ex);
			}
			this.data[path] = void 0;
		}

		return hasChanged;
	}

	static escapeConfigurationKeySegment(value)
	{
		return value.replace("\\", "\\\\").replace(".", "\\.");
	}

	get commandFileFullPath()
	{
		return __resolvePath("~/", this._commandFilePath);
	}

	get commandFilePath()
	{
		return this._commandFilePath;
	}

	set commandFilePath(value)
	{
		if (this._commandFilePath === value) return;
		const oldValue = this._commandFilePath;
		this._commandFilePath = value;
		this.onChanged(".commandFilePath", value, oldValue);
	}

	get configurationFileFullPath()
	{
		return __resolvePath("~/", this._configurationFilePath);
	}

	get configurationFilePath()
	{
		return this._configurationFilePath;
	}

	set configurationFilePath(value)
	{
		if (this._configurationFilePath === value) return;
		const oldValue = this._configurationFilePath;
		this._configurationFilePath = value;
		this.onChanged(".configurationFilePath", value, oldValue);
	}

	get refreshSilenceTimeoutMs()
	{
		return this._refreshSilenceTimeoutMs;
	}

	set refreshSilenceTimeoutMs(value)
	{
		if (value === void 0 || value === null) throw new TypeError(`Argument is null: "value".`);
		if (isNaN(value)) throw new TypeError(`Type mismatch: "value" (1).`);
		if (Math.floor(value) !== value) throw new TypeError(`Type mismatch: "value" (2).`);
		if (value < 0) throw new Error(`Value out of range: "value".`);

		if (this._refreshSilenceTimeoutMs === value) return;
		const oldValue = this._refreshSilenceTimeoutMs;
		this._refreshSilenceTimeoutMs = value;
		this.onChanged(".refreshSilenceTimeoutMs", value, oldValue);
	}
}

function __resolvePath(base, target)
{
	return path.resolve(base.replace('~', os.homedir()), target);
}

module.exports = RuntimeConfigurator;
module.exports.RuntimeConfigurator = module.exports;
