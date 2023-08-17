"use strict";

const { ProfilerTarget } = require("./ProfilerTarget.js"); 

const EventEmitter = require("events");

//	Class: `Profiler` - provides the ability to collect execution time metrics for selected profiling hit points in nodejs application code.
class Profiler extends EventEmitter
{
	//	Constructor: Creates a new instance of the `Profiler` class.
	//	Parameter: `dataCollector: DataCollector | DataCollectorHttpProxy` - an instance responsible for handling incoming data; by default `DataCollector` is used;
	//		custom implementations are possible (see `DataCollector` and `DataCollectorHttpProxy` for implementation details).
	constructor(dataCollector)
	{
		super();

		if (!dataCollector) throw new Error(`Argument is null: "par.dataCollector".`);

		this.dataCollector = dataCollector;

		//	a dictionary of `("<bucketKey>*<key>", ProfilerTarget)` pairs, where `ProfilerTarget` is a holder of the statistical data associated with the given bucket key and profiling key
		this.targetMap = {};

		//	an application-wide counter for all hits created via `__pfbegin` but not yet finalized via `__pfend`
		this.openHitsCount = 0;

		//	an application-wide counter for all hits encountered since the application started
		this.hitCount = 0;
	}

	//	Function: Fires the "error" event whenever a recoverable exception occurs.
	//	Parameter: `ncode: number` - a unique identifier for the codepoint where the error was intercepted.
	//	Parameter: `ex: Error` - the exception instance.
	//	Parameter: `message: string` - additional details about the error.
	onError(ncode, message, ex)
	{
		this.emit("error", ncode, message, ex);
	}

	//	Function: `setDataCollector(dataCollector: DataCollector | DataCollectorHttpProxy)` - Replaces the data collector for this profiler.
	//	Parameter: `dataCollector: DataCollector | DataCollectorHttpProxy` - required; an instance responsible for handling incoming data.
	//	Remarks: This function facilitates the `__pfconfig` interface function and shouldn't be used in other context.
	setDataCollector(dataCollector)
	{
		if (!dataCollector) throw new Error(`Argument is null: "dataCollector".`);
		this.dataCollector = dataCollector;
	}

	//	Function: `log(bucketKey: string, text: string): void` - writes text to the profiling logs without creating a hit point.
	//	Parameter: `bucketKey: string` - a key for grouping and configuration management of profiling data at log-file level; a single profiling bucket usually corresponds to a single
	//		profiling hit point in the code, for Ex. `"CRUD"`, `"REST"`, `"RPC"`, `"VerySpecificSuspiciousLoop"`.
	//	Parameter: `text: string` - a text used as a logging line.
	//	Remarks:
	//		This function never throws an exception.
	//		Always use `Utility.stripStringify` before logging data to ensure that no sensitive data such as unencrypted passwords will appear in the logs.
	log(bucketKey, text)
	{
		if (!this.isEnabled(bucketKey)) return;
		try
		{
			this.dataCollector.log(bucketKey, text);
		}
		catch (ex)
		{
			this.onError(3453348756, "Uncaught exception, please report to raw-profiler vendor", ex);
		}
	}

	//	Function: `begin(bucketKey: string, key: string, text: string): object` - creates, registers and returns a new profiling hit.
	//	Parameter: `bucketKey: string` - a key for grouping and configuration management of profiling data at log-file level; a single profiling bucket usually corresponds to a single
	//		profiling hit point in the code, for Ex. `"CRUD"`, `"REST"`, `"RPC"`, `"VerySpecificSuspiciousLoop"`.
	//	Parameter: `key: string` - a key for grouping of profiling data at statistics level within a bucket; multiple profiling hits (i.e. `Profiler.begin`/`Profiler.end` pairs) for the same
	//		`(bucketKey, key)` pair are aggregated and analysed statistically and produce stats such as minimum, average, maximum and total execution time.
	//	Parameter: `text: string` - a text used as a title for profiling stats tables with `EVerbosity.Brief` and `EVerbosity.Full` and as a logging line with `EVerbosity.Log`;
	//		the `Profiler.end` call can append a postfix text to this text.
	//	Returns: An object representing current state required for the measurements for hit profiling as returned by `ProfilerTarget.hit(title, hitCount, openHitsCount)`;
	//		see `ProfilerTarget.hit(title, hitCount, openHitsCount)` docs for details.
	//	Remarks:
	//		This function never throws an exception.
	//		Always use `Utility.stripStringify` before logging data to ensure that no sensitive data such as unencrypted passwords will appear in the logs.
	begin(bucketKey, key, text)
	{
		if (!this.isEnabled(bucketKey)) return null;
		try
		{
			this.openHitsCount++;
			this.hitCount++;
			return this._ensureProfilerTarget(key, bucketKey).hit(text, this.hitCount, this.openHitsCount);
		}
		catch (ex)
		{
			this.onError(3456348756, "Uncaught exception, please report to raw-profiler vendor", ex);
			return null;
		}
	}

	//	Function: `end(hit: object, postfix: string): null` - calculates profiling data and finalizes a profiling `hit`; initiates the logging of the collected data.
	//	Parameter: `hit: object` - required; the result of the corresponding `Profiler.begin` call.
	//	Parameter: `postfix: string` - optional; appended to the `text` from the corresponding `Profiler.begin` call.
	//	Returns: Always returns `null`. Recommended as a shortcut for releasing the current profiler hit's state, e.g.:
	//	```
	//	    let hit = __pfbegin("bucketKey1", "key1" [, "text"]);
    //		//	... code to profile
    //		hit = __pfend(hit [, " append to text"]);
	//	```
	//	Remarks:
	//		This function never throws an exception.
	//		Always use `Utility.stripStringify` before logging data to ensure that no sensitive data such as unencrypted passwords will appear in the logs.
	end(hit, postfix)
	{
		if (!hit || !this.isEnabled(hit.bucketKey)) return null;
		try
		{
			const target = this.targetMap[hit.bucketKey + "*" + hit.key];
			if (!target) return null;

			target.finish(hit, postfix, this.hitCount, this.openHitsCount);
			--this.openHitsCount;
			this.dataCollector.feed(target.getStats(), hit);
			return null;
		}
		catch (ex)
		{
			this.onError(3456348757, "Uncaught exception, please report to raw-profiler vendor", ex);
			return null;
		}
	}

	//	Function: `flush(callback(err: object): void, stopLogging: boolean): void` - immediately initiates the process of flushing the queues to the logger.
	//	Parameter: `callback(err): void` - required; a callback that is called when flushing finishes.
	//	Parameter: `stopLogging: boolean` - optional, defaults to `true`; if set to true, the current data collector immediately starts ignoring any new data ensuring that there won't be new entries
	//		enqueued. There's no way to resume enqueueing.
	//	Remarks:
	//		This method is intended to enable flushing of the queues on app termination.
	//		This function never throws an exception.
	flush(callback, stopLogging = true)
	{
		try
		{
			return this.dataCollector.flush(err =>
			{
				this.onError(34563487221, "Unhandled error, please report to raw-profiler vendor", err);
				return callback(err);
			}, stopLogging);
		}
		catch (ex)
		{
			this.onError(34563487222, "Uncaught exception, please report to raw-profiler vendor", ex);
			return null;
		}
	}

	//	Function: `isEnabled(bucketKey: string)` - gets the enabled status for the profiling bucket specified by the provided `bucketKey`.
	//	Parameter: `bucketKey: string` - a key for grouping and configuration management of profiling data at log-file level; a single profiling bucket usually corresponds to a single
	//		profiling hit point in the code, for Ex. `"CRUD"`, `"REST"`, `"RPC"`, `"VerySpecificSuspiciousLoop"`.
	//	Returns: `true` if both the data collector currently in use (`this.dataCollector`) and the specific bucket profiling are enabled, otherwise returns `false`.
	//	Remarks: This function considers also the enabled state of the data collector currently in use (`this.dataCollector`).
	isEnabled(bucketKey)
	{
		try
		{
			if (!this.dataCollector.enabled) return false;
			if (!bucketKey) return true;
			return this.dataCollector.isBucketEnabled(bucketKey);
		}
		catch (ex)
		{
			this.onError(3456348759, "Uncaught exception, please report to raw-profiler vendor", ex);
			return false;
		}
	}

	//	Function: `printConfigurationLines(): string` - returns a string containing a formatted multiline list of all effective configuration settings related to profiling.
	//	Returns: a string containing a formatted multiline list of all effective configuration settings related to profiling, e.g.
	//	```
	//	*preconf* runtimeConfigurator.commandFilePath = "__pfenable"
	//	*preconf* runtimeConfigurator.configurationFilePath = "__pfconfig"
	//	*preconf* runtimeConfigurator.refreshSilenceTimeoutMs = 5000
	//	*runtime* dataCollector.enabled = true
	//	*runtime* dataCollector.sortColumn = "maxMs"
	//	*preconf* dataCollector.flushDelayMs = 0
	//	*preconf* dataCollector.logger = "FileLogger"
	//	*preconf* dataCollector.logger.sourceKey = ""
	//	*runtime* dataCollector.logger.verbosity = "full"
	//	*runtime* dataCollector.logger.logPath = "__pflogs"
	//	*runtime* dataCollector.logger.archivePath = "__pfarchive"
	//	*runtime* dataCollector.logger.maxLogSizeBytes = 0 (auto-archiving DISABLED)
	//	*runtime* dataCollector.logger.maxArchiveSizeBytes = 0 (archive trimming DISABLED)
	//	*runtime* dataCollector.logger.logRequestArchivingModulo = 25 (auto-archiving DISABLED)
	//	```
	//	Remarks: "preconf" - a hardcoded setting that cannot be modified at run time; "runtime" - a setting can be modified at run time.
	printConfigurationLines()
	{
		const outcome = this.dataCollector.runtimeConfigurator.getConfigurationLines("runtimeConfigurator").concat(this.dataCollector.getConfigurationLines("dataCollector"));
		let sb = "";
		for (let length = outcome.length, i = 0; i < length; ++i)
		{
			const item = outcome[i];
			sb += (i && "\n" || "") + `[raw-profiler] *${item.type}* ${item.setting} = ${JSON.stringify(item.value)}`;
			item.explanation && (sb += ` (${item.explanation})`);
		}
		return sb;
	}

	_ensureProfilerTarget(key, bucketKey)
	{
		return this.targetMap[bucketKey + "*" + key] || (this.targetMap[bucketKey + "*" + key] = new ProfilerTarget(bucketKey, key));
	}
}

module.exports = Profiler;
module.exports.Profiler = module.exports;
