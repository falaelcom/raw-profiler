"use strict";

const fs = require("fs");
const async = require("async");

const EventEmitter = require("events");

const RC_SIGNAL_OK = 1;
const RC_SIGNAL_DISABLED = 2;
const RC_SIGNAL_UNCONFIGURED = 3;
const RC_SIGNAL_UNCHANGED = 4;
const RC_SIGNAL_EMPTY_DATA = 5;
const RC_SIGNAL_BAD_DATA = 6;
const RC_SIGNAL_ERROR = 7;

//	Class: Facilitates asynchronous reloading of configuration data at runtime.
//	Remarks: Only supports numeric, string and boolean configuration values.
class RuntimeConfiguration extends EventEmitter
{
	//	Parameter: `par: {commandFileFullPath, configurationFileFullPath, refreshSilenceTimeoutMs}`.
	//	Parameter: `par.commandFileFullPath: string` - required; the full path to the runtime command file for `raw-profiler`, e.g. `/home/user/__pfenable`; the existance of the command file
	//		determines the enabled state of the `raw-profiler`; if there is no such file, the `raw-profiler` functionality is completely disabled except for testing for the command file existence.
	//	Parameter: `par.configurationFileFullPath: string` - required; the full path to the runtime configuration file for `raw-profiler`, e.g. `/home/user/__pfconfig`.
	//	Parameter: `par.refreshSilenceTimeoutMs: uint` - defaults to `5000`; run-time configuration refresh-from-file attempts will be performed no more frequently than 
	//		once every `refreshSilenceTimeoutMs` milliseconds.
	//	Parameter: `par.initialEnabled: boolean` - defaults to `true`; provides an initial value for the profiler enabled state before the command file has been queried for the first time.
	//	Remarks: 
	//		Only supports numeric, string and boolean configuration values.
	//		Subscribe for the `changed` event to listen for runtime configuration changes: `new RuntimeConfiguration({...}).on("changed", (key, value, oldValue) => {...})`.
	constructor(par)
	{
		super();

		if (!par) throw new Error(`Argument is null: "par".`);
		if (!par.configurationFileFullPath) throw new Error(`Argument is null: "par.configurationFileFullPath".`);
		if (!par.commandFileFullPath) throw new Error(`Argument is null: "par.commandFileFullPath".`);
		if (par.refreshSilenceTimeoutMs !== void 0 && par.refreshSilenceTimeoutMs !== null && isNaN(par.refreshSilenceTimeoutMs)) throw new TypeError(`Type mismatch: "par.refreshSilenceTimeoutMs" (1).`);
		if (par.refreshSilenceTimeoutMs !== void 0 && par.refreshSilenceTimeoutMs !== null && Math.floor(par.refreshSilenceTimeoutMs) !== par.refreshSilenceTimeoutMs) throw new TypeError(`Type mismatch: "par.refreshSilenceTimeoutMs" (2).`);
		if (par.refreshSilenceTimeoutMs !== void 0 && par.refreshSilenceTimeoutMs !== null && par.refreshSilenceTimeoutMs < 0) throw new Error(`Value out of range: "par.refreshSilenceTimeoutMs".`);
		if (par.initialEnabled !== void 0 && par.initialEnabled !== true && par.initialEnabled !== false) throw new TypeError(`Type mismatch: "par.initialEnabled".`);

		this.commandFileFullPath = par.commandFileFullPath;
		this.configurationFileFullPath = par.configurationFileFullPath;
		this.refreshSilenceTimeoutMs = par.refreshSilenceTimeoutMs || 5000;
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
	onChanged(key, value, oldValue)
	{
		this.emit("changed", key, value, oldValue);
	}

	//	Function: Refreshes the runtime configuraiton if `this.refreshSilenceTimeoutMs` milliseconds ahve been elapsed since the last refresh.
	asyncSmartRefresh(callback)
	{
		if (this.isRefreshing)
		{
			return callback && callback(false);
		}
		if (this.lastRefreshTime && new Date().getTime() - this.lastRefreshTime.getTime() < this.refreshSilenceTimeoutMs)
		{
			return callback && callback(false);
		}
		this.isRefreshing = true;

		return this._reload(function (signal)
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
					}
					break;
				case RC_SIGNAL_DISABLED:
					if (this.enabled)
					{
						this.enabled = false;
						console.log("[raw-profiler]", "Enabled is now set to:", this.enabled);
					}
					break;
				default: throw new Error(`Not implemented.`);
			}
			return callback && callback(true);
		}.bind(this));
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
						this._readConfigurationData(JSON.parse(json));
						return next(null);
					}
					catch (ex)
					{
						console.log(236851, "[raw-profiler]", "Error in runtime configuration JSON (file path \"" + this.configurationFileFullPath + "\"): ", ex);
						return next(RC_SIGNAL_BAD_DATA);
					}

				}.bind(this),
			], function (signal)
			{
				switch (signal)
				{
					case null:
						return callback(RC_SIGNAL_OK);
					case RC_SIGNAL_DISABLED:
					case RC_SIGNAL_UNCHANGED:
					case RC_SIGNAL_BAD_DATA:
						return callback(signal);
					case RC_SIGNAL_UNCONFIGURED:
					case RC_SIGNAL_EMPTY_DATA:
						this._readConfigurationData({});
						return callback(signal);
					default:
						console.log(2368501, "[raw-profiler]", "Error reading the runtime configuration JSON (file path \"" + this.configurationFileFullPath + "\"): ", signal);
						return callback(RC_SIGNAL_ERROR);
				}
			}.bind(this));
	}

	//	Remarks: Only supports numeric, string and boolean configuration values.
	_readConfigurationData(data)
	{
		function __traverse(obj, visit, prefix = "")
		{
			for (const key in obj)
			{
				const value = obj[key];
				const path = prefix + RuntimeConfiguration.escapeConfigurationKeySegment(key);
				if (value === 0 || (value && value.constructor === Number)) visit(path, value);
				else if (value === "" || (value && value.constructor === String)) visit(path, value);
				else if (value === true || value === false || (value && value.constructor === Boolean)) visit(path, value);
				else __traverse(value, visit, path + '.');
			}
		}

		const keySet = new Set();
		__traverse(data, (path, value) =>
		{
			keySet.add(path);
			const oldValue = this.data[path];
			if (oldValue === value) return;
			try
			{
				this.onChanged(path, value, oldValue);
			}
			catch (ex)
			{
				console.error(2368502, "[raw-profiler]", "The RuntimeConfiguration.prototype.changed callback has thrown an exception", ex);
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
				this.onChanged(path, void 0, value);
			}
			catch (ex)
			{
				console.error(2368503, "[raw-profiler]", "The RuntimeConfiguration.prototype.changed callback has thrown an exception", ex);
			}
			this.data[path] = void 0;
		}
	}

	static escapeConfigurationKeySegment(value)
	{
		return value.replace("\\", "\\\\").replace(".", "\\.");
	}
}

module.exports = RuntimeConfiguration;
module.exports.RuntimeConfiguration = module.exports;
