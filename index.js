"use strict";

//	TODO:
//		- Provide same configuration options from code(the`__pfconfig` function call) and from file (the`__pfconfig` file JSON).
//		- add remote configuration acquisition from a logging server rest point
//		- make sure all open hits end before the profiler/bucket enabled state changes
//		- there are several flags such as `isRefreshing`; if necessary, add code to make sure that no exception or error might leave such flags up forever
//		- The CPU usage is being calculated based on OS and not node js process CPU stats(older node js versions lack a required api).Desired solution - detect node js version and enable node js process CPU stats when possible.
//		- Add disk space and log size stats to the bucket table headers.
//	DEBT:
//	    -- migrate to async/await syntax
//		-- replace all `.bind` calls with lambda functions
//		-- cache `hit.bucketKey + "*" + hit.key` in the hit
//		-- get rid of all `fs.*Sync` calls in FileLogger; currently synch calls only affect the logging server, and the task is not of highest priority
//		-- add parameter value validation throughout the code
//		-- provide a way to override default logging to console (e.g. `__pfconfig(console: <consoleLike_Object>)`)

const { EVerbosity } = require("./lib/EVerbosity.js");
const { Utility } = require("./lib/Utility.js");
const { RuntimeConfiguration } = require("./lib/RuntimeConfiguration.js");
const { ConsoleLogger } = require("./lib/ConsoleLogger.js"); 
const { FileLogger } = require("./lib/FileLogger.js");
const { DataCollector } = require("./lib/DataCollector.js");
const { DataCollectorHttpProxy } = require("./lib/DataCollectorHttpProxy.js"); 
const { MachineStats } = require("./lib/MachineStats.js");
const { Profiler } = require("./lib/Profiler.js");
const { DataCollectorServer } = require("./lib/DataCollectorServer.js");

//#region Interface
const _onInfo = (source, message) => console.log("[raw-profiler]", `[${source}]`, message);
const _onError = (source, ncode, message, ex) => console.error("[raw-profiler]", `[${source}]`, ncode, message, ex, ex.stack);
const _onConfigurationChanged = (source, key, value, oldValue) => console.log("[raw-profiler]", `[${source}]`, `Runtime configuration field "${key}" changed from ${JSON.stringify(oldValue)} to ${JSON.stringify(value)}.`);

//	The `runtimeConfiguration` instance is a shared between all configuration targets.
const runtimeConfiguration = new RuntimeConfiguration(
{
	commandFilePath: "__pfenable",
	configurationFilePath: "__pfconfig",
	refreshSilenceTimeoutMs: 5000,
});

let defaultConsoleLogger = null;
let defaultFileLogger = null;
let defaultDataCollector = null;
let defaultProfiler = null;

//	Object: Publishes more profiling and configuration facilities beyond the `__pf*` function family.
const __pf =
{
	//	Field: `EVerbosity: object` - The `EVerbosity` enum.
	EVerbosity,

	//	Field: `instance: Profiler` - The single instance of `Profiler`.
	get instance()
	{
		if (defaultProfiler) return defaultProfiler;
		defaultProfiler = new Profiler(this.DataCollector);
		return defaultProfiler;
	},

	//	Field: `osResourceStats: object` - a shorcut to `MachineStats.osResourceStats`.
	get osResourceStats()
	{
		return MachineStats.osResourceStats;
	},

	//	Field: `FileLogger: FileLogger` - a preconfigured default `FileLogger` instance.
	get FileLogger()
	{
		if (defaultFileLogger) return defaultFileLogger;
		defaultFileLogger = new FileLogger(
		{
			runtimeConfiguration,
			fallbackConfiguration:
			{
				verbosity: EVerbosity.Full,
				logPath: "__pflogs",
				archivePath: "__pfarchive",
				maxLogSizeBytes: 0,				//	archiving disabled
				maxArchiveSizeBytes: 0,			//  archive trimming disabled
				logRequestArchivingModulo: 25,
			},
			sourceKey: "",
		});
		defaultFileLogger.on("info", (...args) => _onInfo("default-file-logger", ...args));
		defaultFileLogger.on("error", (...args) => _onError("default-file-logger", ...args));
		defaultFileLogger.on("configurationChanged", (...args) => _onConfigurationChanged("default-file-logger", ...args));
		return defaultFileLogger;
	},

	//	Field: `ConsoleLogger: ConsoleLogger` - a preconfigured default `ConsoleLogger` instance.
	get ConsoleLogger()
	{
		if (defaultConsoleLogger) return defaultConsoleLogger;
		defaultConsoleLogger = new ConsoleLogger(
		{
			runtimeConfiguration,
			fallbackConfiguration:
			{
				verbosity: EVerbosity.Full,
			}
		});
		defaultConsoleLogger.on("configurationChanged", (...args) => _onConfigurationChanged("default-console-logger", ...args));
		return defaultConsoleLogger;
	},

	//	Field: `DataCollector: DataCollector` - a preconfigured default `DataCollector` instance that uses `ConsoleLogger`.
	get DataCollector()
	{
		if (defaultDataCollector) return defaultDataCollector;
		defaultDataCollector = new DataCollector(
		{
			runtimeConfiguration,
			fallbackConfiguration:
			{
				sortColumn: "maxMs",
			},
			logger: this.ConsoleLogger,
			flushDelayMs: 0,
		});
		defaultDataCollector.on("error", (...args) => _onError("default-data-collector", ...args));
		defaultDataCollector.on("configurationChanged", (...args) => _onConfigurationChanged("default-data-collector", ...args));
		return defaultDataCollector;
	},

	//	Function: `createDataCollectorHttpProxy(par: object): DataCollectorHttpProxy` - creates and configures a new `DataCollectorServer` instance.
	//	Parameter:
	//	```
	//	par:
	//	{
	//		uri: string,				//	required; will forward profiling data by sending HTTP requests to this endpoint.
	//		sourceKey: string,			//	required; this key is used by the remote logging server as part of the log file paths allowing for multiple application servers to feed data to a single logging server
	//		requestTimeoutMs: uint,		//	required; specifies a timeout for HTTP requests before abortion.
	//		failureTimeoutMs: uint,		//	required; specifies the time between reporting repeated HTTP request failures.
	//	}
	//	```
	//	Returns: the newly created and configured `DataCollectorHttpProxy` instance.
	createDataCollectorHttpProxy: function (par)
	{
		const result = new DataCollectorHttpProxy(
		{
			runtimeConfiguration,
			fallbackConfiguration:
			{
				uri: par.uri,
				sourceKey: par.sourceKey,
				requestTimeoutMs: par.requestTimeoutMs,
				failureTimeoutMs: par.failureTimeoutMs,
			},
		});
		result.on("info", (...args) => _onInfo("data-collector-server", ...args));
		result.on("error", (...args) => _onError("data-collector-server", ...args));
		return result;

		console.log("[raw-profiler]", "Feeding data to " + this.uri);
		return new DataCollectorHttpProxy(url, sourceKey, null)
	},

	//	Function: `createDataCollectorServer(par: void | object)` - creates and configures a new `DataCollectorServer` instance.
	//	Parameter:
	//	```
	//	par:				//	optional
	//	{
	//		host: string,	//	optional, defaults to `"0.0.0.0"`; a host name or IP address to listen on, e.g. `"0.0.0.0"`.
	//		port: uint,		//	optional, defaults to `9666`; an HTTP port to listen on, e.g. `9666`.
	//		fileLogger:		//	optional
	//		{
	//			verbosity: EVerbosity,				//	optional, defaults to `EVerbosity.Full`
	//			logPath: string,					//	optional, defaults to `"__pflogs"`
	//			archivePath: string,				//	optional, defaults to `"__pfarchive"`
	//			maxLogSizeBytes: uint,				//	optional, defaults to `200 * 1024 * 1024` (200MB); use `0` to disable log archiving
	//			maxArchiveSizeBytes: uint,			//	optional, defaults to `1024 * 1024 * 1024` (1GB); use `0` to disable archive collection trimming
	//			logRequestArchivingModulo: uint,	//	optional, defaults to `100`; use `0` to disable log archiving
	//		},
	//		dataCollector:	//	optional
	//		{
	//			sortColumn: stirng,					//	optional, defaults to `"maxMs"`
	//			flushDelayMs: uint,					//	optional, defaults to `0`
	//		}
	//	}
	//	```
	//	Returns: the newly created and configured `DataCollectorServer` instance.
	createDataCollectorServer: function (par)
	{
		par = par || {};

		const result = new DataCollectorServer(
		{
			host: par.host || "0.0.0.0",
			port: par.port || 9666,
			createDataCollector(sourceKey)
			{
				const fileLogger = new FileLogger(
				{
					runtimeConfiguration,
					fallbackConfiguration:
					{
						verbosity: (par.fileLogger && par.fileLogger.verbosity)
							|| EVerbosity.Full,
						logPath: (par.fileLogger && par.fileLogger.logPath)
							|| "__pflogs",
						archivePath: (par.fileLogger && par.fileLogger.archivePath)
							|| "__pfarchive",
						maxLogSizeBytes: (par.fileLogger && !isNaN(par.fileLogger.maxLogSizeBytes))
							? par.fileLogger.maxLogSizeBytes : 200 * 1024 * 1024, //  200MB
						maxArchiveSizeBytes: (par.fileLogger && !isNaN(par.fileLogger.maxArchiveSizeBytes))
							? par.fileLogger.maxArchiveSizeBytes : 1024 * 1024 * 1024,	//  1GB
						logRequestArchivingModulo: (par.fileLogger && !isNaN(par.fileLogger.logRequestArchivingModulo))
							? par.fileLogger.logRequestArchivingModulo : 100,
					},
					sourceKey,
				});
				fileLogger.on("info", (...args) => _onInfo(`file-logger:${sourceKey}`, ...args));
				fileLogger.on("error", (...args) => _onError(`file-logger:${sourceKey}`, ...args));
				fileLogger.on("configurationChanged", (...args) => _onConfigurationChanged(`file-logger:${sourceKey}`, ...args));

				const result = new DataCollector(
				{
					runtimeConfiguration,
					fallbackConfiguration:
					{
						sortColumn: (par.dataCollector && par.dataCollector.sortColumn) || "maxMs",
					},
					logger: fileLogger,
					flushDelayMs: (par.dataCollector && !isNaN(par.dataCollector.flushDelayMs)) || 0,
				});
				result.on("error", (...args) => _onError(`data-collector:${sourceKey}`, ...args));
				result.on("configurationChanged", (...args) => _onConfigurationChanged(`data-collector:${sourceKey}`, ...args));

				return result;
			},
		});
		result.on("info", (...args) => _onInfo("data-collector-server", ...args));
		result.on("error", (...args) => _onError("data-collector-server", ...args));
		return result;
	},

	//	Function: `createFileLogger(par: void | object)` - creates and configures a new `FileLogger` instance.
	//	Parameter:
	//	```
	//	par:				//	optional
	//	{
	//		verbosity: EVerbosity,				//	optional, defaults to `EVerbosity.Full`
	//		logPath: string,					//	optional, defaults to `"__pflogs"`
	//		archivePath: string,				//	optional, defaults to `"__pfarchive"`
	//		maxLogSizeBytes: uint,				//	optional, defaults to `0` (disabled); use `0` to disable log archiving
	//		maxArchiveSizeBytes: uint,			//	optional, defaults to `0` (disabled); use `0` to disable archive collection trimming
	//		logRequestArchivingModulo: uint,	//	optional, defaults to `25`
	//		sourceKey: string,					//	optional, defaults to `""`
	//	}
	//	```
	//	Returns: the newly created and configured `FileLogger` instance.
	createFileLogger: function (par)
	{
		par = par || {};

		const result = new FileLogger(
		{
			runtimeConfiguration,
			fallbackConfiguration:
			{
				verbosity: par.verbosity || EVerbosity.Full,
				logPath: par.logPath || "__pflogs",
				archivePath: par.archivePath || "__pfarchive",
				maxLogSizeBytes: !isNaN(par.maxLogSizeBytes) ? par.maxLogSizeBytes : 0,
				maxArchiveSizeBytes: !isNaN(par.maxArchiveSizeBytes) ? par.maxArchiveSizeBytes : 0,
				logRequestArchivingModulo: !isNaN(par.logRequestArchivingModulo) ? par.maxArchiveSizeBytes : 25,
			},
			sourceKey: par.sourceKey,
		});
		result.on("info", (...args) => _onInfo("default-file-logger", ...args));
		result.on("error", (...args) => _onError("default-file-logger", ...args));
		result.on("configurationChanged", (...args) => _onConfigurationChanged("default-file-logger", ...args));
		return result;
	},

	//	Object: A collection of utility functions to aid the building of profiling hit point keys.
	utility:
	{
		//	Function: `getKeysText(obj: object): string` - prints into a string a coma-separated list of the enumerable property names of `obj`.
		//	Parameter: `obj: object` - the input object to format.
		//	Returns: a coma-separated list of the enumerable property names of `obj`, e.g. `{a:1, b:"B", c:true}` will produce `"a,b,c"`.
		//	Remarks: This function effectively serializes the top-level of the object schema. Used when building profile hit keys.
		getKeysText: function (obj)
		{
			try
			{
				return Utility.getKeysText(obj);
			}
			catch (ex)
			{
				console.error(3456348760, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
				return "";
			}
		},

		//	Function: `stripStringify(obj: object, stripFieldPaths: [string]): string` - stringifies `obj` via `JSON.stringify` while replacing all values at the specified `stripFieldPaths` 
		//		by `"(stripped by raw-profiler)"`.
		//	Parameter: `obj: object` - the input object to stringify.
		//	Parameter: `stripFieldPaths: [string]` - an array of property paths in the format `"prop1.prop2.prop3"`.
		//	Returns: a string generated by `JSON.stringify` with all values at the specified `stripFieldPaths` replaced by `"(stripped by raw-profiler)"`.
		//	Remarks:
		//		Always use this function before logging data to make sure that no sensitive data such as unencrypted passwords will appear in the logs.
		//		Does not support stripping of array values or their members. This feature is pending implementation and requires a more complex path syntax that supports array annotation.
		stripStringify: function (obj, stripFieldPaths)
		{
			try
			{
				return Utility.stripStringify(obj, stripFieldPaths);
			}
			catch (ex)
			{
				console.error(3456348761, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
				return "";
			}
		},

		//	Function: `stripStringifyArray(arr: array, stripFieldPaths: [string]): string` - stringifies `arr` while replacing all values at the specified `stripFieldPaths`
		//		by `"(stripped by raw-profiler)"` (WARNING: at this time stripping in arrays is not implemented).
		//	Parameter: `arr: array` - the input arr to stringify.
		//	Parameter: `stripFieldPaths: [string]` - an array of property paths in the format `"prop1.prop2.prop3"` (WARNING: at this time stripping in arrays is not implemented).
		//	Returns: the array serialized as JSON with all values at the specified `stripFieldPaths` replaced by `"(stripped by raw-profiler)"` (WARNING: at this time stripping in arrays is not implemented).
		//	Remarks:
		//		Always use this function before logging data to make sure that no sensitive data such as unencrypted passwords will appear in the logs.
		//		Does not support stripping of array values or their members. This feature is pending implementation and requires a more complex path syntax that supports array annotation.
		//		As a result, at this time this method is unable to strip anyting.
		stripStringifyArray: function (arr, stripFieldPaths)
		{
			try
			{
				return Utility.stripStringifyArray(arr, stripFieldPaths);
			}
			catch (ex)
			{
				console.error(3456348762, "[raw-profiler]", "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
				return "";
			}
		},
	},
};

//	Function: `__pfconfig(par: object): void` - Reconfigures the default `DataCollector` for the `Profiler` single instance.
//	Parameter: `par: object` - required.
//	Parameter: `par.dataCollector: DataCollector` - optional; if set, the data collector for the `Profiler` single instance is replaced with `par.dataCollector` and all other `par` 
//		fields are ignored.
//	Parameter: `par.sortColumn: string` - optional, defaults to `"maxMs"`; an initial and default value for the default `sortColumn` setting.
//	Parameter: `par.logger: ConsoleLogger | FileLogger | { logBuckets: function }` - optional, defaults to `ConsoleLogger`; a new `DataCollector` will be created with the provided logger;
//		`DataCollector` will invoke `this.logger.logBuckets()` every time it's ready to flush collected data; see the implementation of `ConsoleLogger` and `FileLogger` for 
//		details on implementing custom loggers.
//	Parameter: `par.flushDelayMs: uint` - optional, defaults to `0`; a new `DataCollector` will be created with the provided `flushDelayMs`; used as a parameter for 
//		a `setTimeout` before flushing the queues.
//	Parameter: `par.commandFilePath: string` - optional, defaults to `"__pfenable)`; the path to the runtime command file for `raw-profiler`, 
//		e.g. `/home/user/__pfenable`; the existance of the command file determines the enabled state of the `raw-profiler`; if there is no such file, the `raw-profiler` 
//		functionality is completely disabled except for testing for the command file existence.
//	Parameter: `par.configurationFilePath: string` - optional, defaults to `"__pfconfig"`; the path to the runtime configuration file for `raw-profiler`, 
//		e.g. `/home/user/__pfconfig`.
//	Parameter: `par.refreshSilenceTimeoutMs: uint` - optional, defaults to `5000`; run-time configuration refresh-from-file attempts will be performed no more frequently than
//		once every `refreshSilenceTimeoutMs` milliseconds.
//	Parameter: `par.initialEnabled: boolean` - defaults to `true`; provides an initial value for the profiler enabled state before the command file has been queried for the first time.
//	Remarks: 
//		This function never throws an exception.
function __pfconfig(par)
{
	try
	{
		if (par.commandFilePath !== void 0 && par.commandFilePath !== null) runtimeConfiguration.commandFilePath = par.commandFilePath;
		if (par.configurationFilePath !== void 0 && par.configurationFilePath !== null) runtimeConfiguration.configurationFilePath = par.configurationFilePath;
		if (par.refreshSilenceTimeoutMs !== void 0 && par.refreshSilenceTimeoutMs !== null) runtimeConfiguration.refreshSilenceTimeoutMs = par.refreshSilenceTimeoutMs;

		if (par.dataCollector) return __pf.instance.setDataCollector(par.dataCollector);

		const arg = {};
		arg.runtimeConfiguration = runtimeConfiguration;
		arg.fallbackConfiguration = {};
		arg.fallbackConfiguration.sortColumn = (par && par.sortColumn) ? par.sortColumn : "maxMs";
		arg.logger = par.logger || __pf.ConsoleLogger;
		arg.flushDelayMs = par.flushDelayMs !== void 0 ? par.flushDelayMs : 0;

		const dataCollector = new DataCollector(arg);
		dataCollector.on("error", (...args) => _onError("data-collector", ...args));
		dataCollector.on("configurationChanged", (...args) => _onConfigurationChanged("data-collector", ...args));

		if (defaultProfiler)
		{
			if (__pf.instance.dataCollector)
			{
				__pf.instance.dataCollector.removeAllListeners("error");
				__pf.instance.dataCollector.removeAllListeners("configurationChanged");
			}
			__pf.instance.setDataCollector(dataCollector);
		}
		else defaultProfiler = new Profiler(dataCollector);
	}
	catch (ex)
	{
		console.error("[raw-profiler]", 3456348758, "Uncaught exception, please report to raw-profiler vendor", ex, ex.stack);
	}
}

//	Function: `__pfenabled(bucketKey: string)` - gets the enabled status for the profiling bucket specified by the provided `bucketKey`.
//	Parameter: `bucketKey: string` - a key for grouping and configuration management of profiling data at log-file level; a single profiling bucket usually corresponds to a single
//		profiling hit point in the code, for Ex. `"CRUD"`, `"REST"`, `"RPC"`, `"VerySpecificSuspiciousLoop"`.
//	Returns: `true` if both the data collector currently in use and the specific bucket profiling are enabled, otherwise returns `false`.
//	Remarks: 
//		This function considers also the enabled state of the data collector currently in use (`this.dataCollector`).
//		This function never throws an exception.
function __pfenabled(bucketKey)
{
	return __pf.instance.isEnabled(bucketKey);
}

//	Function: `__pfbegin(bucketKey: string, key: string, text: string): object` - creates, registers and returns a new profiling hit.
//	Parameter: `bucketKey: string` - a key for grouping and configuration management of profiling data at log-file level; a single profiling bucket usually corresponds to a single
//		profiling hit point in the code, for Ex. `"CRUD"`, `"REST"`, `"RPC"`, `"VerySpecificSuspiciousLoop"`.
//	Parameter: `key: string` - a key for grouping of profiling data at statistics level within a bucket; multiple profiling hits (i.e. `__pfbegin`/`__pfend` pairs) for the same
//		`(bucketKey, key)` pair are aggregated and analysed statistically and produce stats such as minimum, average, maximum and total execution time.
//	Parameter: `text: string` - a text used as a title for profiling stats tables with `EVerbosity.Brief` and `EVerbosity.Full` and as a logging line with `EVerbosity.Log`;
//		the `__pfend` call can append a postfix text to this text.
//	Returns: An object representing current state required for the measurements for hit profiling as returned by `ProfilerTarget.hit(title, hitCount, openHitsCount)`;
//		see `ProfilerTarget.hit(title, hitCount, openHitsCount)` docs for details.
//	Remarks: 
//		This function never throws an exception.
//		Always use `Utility.stripStringify` before logging objects via `title` to ensure that no sensitive data such as unencrypted passwords will appear in the logs.
function __pfbegin(bucketKey, key, title)
{
	return __pf.instance.begin(bucketKey, key, title);
}

//	Function: `__pfend(hit: object, postfix: string): null` - calculates profiling data and finalizes a profiling `hit`; initiates the logging of the collected data.
//	Parameter: `hit: object` - required; the result of the corresponding `__pfbegin` call.
//	Parameter: `postfix: string` - optional; appended to the `text` from the corresponding `__pfbegin` call.
//	Returns: Always returns `null`. Recommended as a shortcut for releasing the current profiler hit's state, e.g.:
//	```
//	    let hit = __pfbegin("bucketKey1", "key1" [, "text"]);
//		//	... code to profile
//		hit = __pfend(hit [, " append to text"]);
//	```
//	Remarks: 
//		This function never throws an exception.
//		Always use `Utility.stripStringify` before logging objects via `title` to ensure that no sensitive data such as unencrypted passwords will appear in the logs.
function __pfend(hit, postfix)
{
	return __pf.instance.end(hit, postfix);
}

//	Function: `__pfflush(callback(err: object): void, stopLogging: boolean): void` - immediately initiates the process of flushing the queues to the logger.
//	Parameter: `callback(err): void` - required; a callback that is called when flushing finishes.
//	Parameter: `stopLogging: boolean` - optional, defaults to `true`; if set to true, the current data collector immediately starts ignoring any new data ensuring that there won't be new entries
//		enqueued. There's no way to resume enqueueing.
//	Remarks: 
//		This method is intended to enable flushing of the queues on app termination.
//		This function never throws an exception.
function __pfflush(callback, stopLogging = true)
{
	return __pf.instance.flush(callback, stopLogging);
}

MachineStats.startCpuMonitoring();

module.exports =
{
	globals()
	{
		global.__pf = __pf;
		global.__pfconfig = __pfconfig;
		global.__pfenabled = __pfenabled;
		global.__pfbegin = __pfbegin;
		global.__pfend = __pfend;
	}
};
module.exports.__pf = __pf;
module.exports.__pfconfig = __pfconfig;
module.exports.__pfenabled = __pfenabled;
module.exports.__pfbegin = __pfbegin;
module.exports.__pfend = __pfend;
module.exports.__pfflush = __pfflush;
//#endregion