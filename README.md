ABSTRACT
==================================================

The purpose of `raw-profiler` is to enable nodejs application profiling and high-volutme logging in production environments *without* the need for reconfiguration downtime, external 
service dependencies or running environment reconfiguration. To acieve this goal, `raw-profiler` offers the following facilities:

- API for adding profiling and logging directly into application's code;
- control of profiling and logging levels without restarting the running instances, from none to full;
- remote logging for offloading the application server from computationally-intense string-concatenation and IO operations;
- log lifecycle management, including log rotation, archiving and compression.

Consider the following before using `raw-profiler`:

* This node package does not provide any user inteface. Its sole purpose is to facilitate the generation and management of profiling- and other log data in an efficient way.
Other tools shall be used to monitor and examine the generated logs.

* `raw-profiler` keeps accumulated statistical data in memory. Restarting the application (or the logging server in remote scenarios) will reset the data. Log files are
persisted between restarts.

* Log data is queued in memory and written on disk with a configurable delay. Exiting the application without flushing the logs will most likely result in logging data loss.

The best way to fully understand `raw-profiler` is to experiment with it. It's recommended to start with simple console logging (default) and gradually increase the scenario complexity
towards file logging and remote logging. See the "Getting Started" section below.

FEATURES OVERVIEW
==================================================

- **Measuring and logging of sync and async code execution times**, based on manually placed profiling API function calls.
- **Execution statistics** collecting and logging - execution counters, min, average, max and total execution times, CPU usage during execution and various OS CPU and memory usage stats.
- **Suitable for production environments** - enable and disable profiling without restarting the application (see below). 
- **Near-zero performance overhead when profiling is disabled**; performance overhead with profiling enabled is manageable via verbosity settings adjustment and remote logging.
- **Use with heavy server loads with no performance impact** - easy to set up remote logging via HTTP.
- **Centralized logging** - syphon the logging and profiling feed from all your web servers towards a single logging server.
- **Detection** and logging of never-ending profiling incidents.
- **Monitor** the current statistics, examine full stats history.
- **Structure** the stats into profiling buckets for easier analysis.
- **Extensible** - provides easy ways to create custom loggers and data collector proxies.
- **Configurable logging in-memory queue** with delayed file system writing operations, implemented as part of the default file logger.
- **Automatic log rotation and compression**  of log files.
- **Automatic removal** of archive files.
- **Easy to use** - minimal code is required to set up and profile.

GLOSSARY
==================================================

The following terminology is used to describe the profiler's set up and operation:

- **Profiling hit** - a single run-time profiling incident that starts with a `__pfbegin()` call and ends with a corresponding `__pfend()` call.

- **Profiling hit point** - a location in the application code where some profiling begins, marked by a `__pfbegin()` call.

- **Profiling key** - a key to identify a specific profiling hit, usually dynamically generated when a profiling hit occurs. Stats such as min, average and max execution times
are calculated per profiling key. Profiling keys are recommended to be specific enough to reflect the intention of the code being profiled, while staying generic enough to aggregate 
enough data for statistics. As an example, under the `"CRUD"` bucket (see below for the definition of "bucket"), possible profiler keys could be the strings `"READ user [_id]"` or 
`"CREATE patient [name,email,ssn,password]"`. The key `"CREATE patient [name,email,ssn,password]"` will aggregate all create db ops for the `patient` collection with record schema 
containing the fields `name`, `email`, `ssn`, `password`, regardless of the specific field values. On the other hand, a key incorporating specific field values, e.g. 
`"CREATE patient [John,john@email.com,0011394075,MySeCrEt1]"` would be hit only once or twice during the whole application life time and won't provide any usable statistical data.
Profiling key count is set to increase during application's uptime.

- **Profiling bucket** - a collection of profiling keys, which enables profiling and logging management granularity; a single profiling bucket usually corresponds to a single 
profiling hit point or several closely related profiling hit points in the code, for Ex. `"CRUD"`, `"REST"`, `"RPC"`, `"VerySpecificSuspiciousLoop"`. A profiling bucket is identified by
its **profiling bucket key**. Profiling bucket keys are predefined and hardcoded by the developer, and their amount is fixed during application execution. The bucket key `"header"` is 
reserved and should never be used explicitly. Profiling buckets define the unit for logging- and profiling control granularity; logging and profiling can be configured and switched on/off 
per profiling bucket; log files are organized in files based on profiling bucket keys.

- **Profiling hit title** - printed as a part of the heading of the stats table for a single profiling hit. The profiling hit title appears as a log line when profiling data printing is 
disabled, effectively providing a facility for pure logging without profiling.

- **Profiling hit postfix** - provided at the end of the profiling hit; appended to the hit title. Profiling hit postfixes appear as part of the log lines when profiling data printing is 
disabled, effectively providing a facility for pure logging without profiling.

- **Local profiling** - all stats formatting and logging is done on the application server; the time required for formatting of statistics and logging affects the application pefrormance 
and can interfere with the profiling results in case of nested profiling hit points.

- **Remote profiling** - the profiler only performs measurments and simple mathematical operations on the application server, forwarding the results to a remote
machine (the profiler data collector); all stats formatting and logging, which imposes heavy loads on the memory and CPU, is done on the remote server.

IMPORTING RAW-PROFILER INTO YOUR APPLICAITON
==================================================

There are two ways to import `raw-profiler`:

1. Inline, in every file where it's being used:

    `const { __pf, __pfconfig, __pfenabled, __pfbegin, __pfend, __pflog, __pfschema } = require("raw-profiler");`

2. Globally, in the main application file:

    `require("raw-profiler").global();`

Option 1. is complient with the best programming practices by avoiding global scope contamination.

Option 2. allows for adding and removing of logging and profiling code quickly and easily without the burden of constantly adding and removing profiling function declarations. When working
on large projects with lots of logging and profiling, this consideration might overcome the best programming practice requirements. `raw-profiler` intentionally uses rather
specific function names lowering the chance for name collisions.

For illustrative purposes, both import styles are used interchangeably in this document.

INTERFACE
==================================================

* `__pfconfig()` - Reconfigures the default `DataCollector` for the `Profiler` single instance. See `index.js`, `function __pfconfig(par)` for code comments.
This function never throws an exception. See below for usage examples.

* `__pfenabled()` - Gets the enabled status for the profiling bucket specified by the provided `bucketKey`. See `index.js`, `function __pfenabled(bucketKey)` for code comments.
This function never throws an exception. See below for usage examples.

* `__pfbegin()` - Creates, registers and returns a new profiling hit. See `index.js`, `function __pfbegin(bucketKey, key, title)` for code comments.
This function never throws an exception. See below for usage examples.

* `__pfend()` - Calculates profiling data and finalizes a profiling hit; initiates the logging of the collected data. See `index.js`, `function __pfend(hit, postfix)` for code comments.
This function never throws an exception. See below for usage examples.

* `__pflog()` - Records log `text` under the `bucketKey` with a hardcoded profiling key `"__pflog"` and no relevant execution data. See `index.js`, `function __pflog(bucketKey, text)` for code comments.
This function never throws an exception. See below for usage examples.

* `__pfflush()` - immediately initiates the process of flushing the queues to the logger. See `index.js`, `function __pfflush(callback, stopLogging = true)` for code comments.
This function never throws an exception. See below for usage examples.

* `__pfschema()` - 

* `__pf` - an object holding the current state of the profiler, helper functions and properties; see `index.js` for code comments:
    - `__pf.DefaultFileLogger` - a preconfigured default `FileLogger` instance;
    - `__pf.DefaultConsoleLogger` - a preconfigured default `ConsoleLogger` instance;
    - `__pf.DefaultDataCollector` - a preconfigured default `DataCollector` instance that uses `ConsoleLogger`;
    - `__pf.instance` - the single instance of `Profiler`;
    - `__pf.instance.printConfigurationLines()` - 
    - `__pf.createDataCollectorServer()` - creates and configures a new `DataCollectorServer` instance;
    - `__pf.utility.getKeysText(value)` - prints into a string a coma-separated list of the enumerable property names of `obj`;
    - `__pf.utility.stripStringify(obj, stripFieldPaths)` - stringifies `obj` via `JSON.stringify` while replacing all values at the specified `stripFieldPaths` by `"(stripped by raw-profiler)"`;
    - `__pf.utility.stripStringifyArray(arr, stripFieldPaths)` - stringifies `arr` while replacing all values at the specified `stripFieldPaths`;
	- `__pf.osResourceStats` - a shorcut to `MachineStats.osResourceStats`; updated every 5 seconds;
    - `__pf.osResourceStats.avgCpu10sec` - OS CPU average for 10 s time window;
	- `__pf.osResourceStats.avgCpu1min` - OS CPU average for 1 min time window;
	- `__pf.osResourceStats.avgCpu5min` - OS CPU average for 5 min time window;
	- `__pf.osResourceStats.avgCpu15min` - OS CPU average for 15 min time window;
	- `__pf.osResourceStats.psCpuUsage` - {system: 0, user: 0} or the return value of process.cpuUsage(), if this method is supported;
	- `__pf.osResourceStats.psMemUsage` - the return value of process.memoryUsage();
	- `__pf.osResourceStats.psUptime` - the return value of process.uptime(),
	- `__pf.osResourceStats.osUptime` - the return value of os.uptime(),

* `EVerbosity` - the `EVerbosity: { Log: "log", Brief: "brief", Full: "full" }` enum;
* `RuntimeConfiguration` - The `RuntimeConfiguration` class;
* `ConsoleLogger` - The `ConsoleLogger` class;
* `FileLogger` - The `FileLogger` class;
* `DataCollector` - The `DataCollector` class;
* `DataCollectorHttpProxy` - The `DataCollectorHttpProxy` class;
* `MachineStats` - The `MachineStats` class;
* `Profiler` - The `Profiler` class;
* `DataCollectorServer` - The `DataCollectorServer` class.

_NOTE: When required, the `raw-profiler` module starts its own system and process resources monitoring timer with resolution 5s (non-configurable). The collected stats are used for profiling and are available at any time via `__pf.osResourceStats` as well. All values are updated every 5 seconds. Using cached values prevents the nodejs process from exhausting available file descriptors on extremely heavy server loads (every sytem/process resource check is done by reading from a /proc/* or /sys/* or /dev/* file). Because of the caching, the RAM deltas reported in log files are no more precise (the 5s update resolution is way too large for a typical profiling hit), but can be informative when profiling long-lasting processes._

DEFAULTS
==================================================

|Category|Setting|Name|Default value|Default value meaning
|--|--|--|--|--
|Runtime configuration|Command file path|`commandFilePath`|`"~/__pfenable"`|-
|Runtime configuration|Configuration file path|`configurationFilePath`|`"~/__pfconfig"`|-
|Runtime configuration|Refresh silence timeout (in milliseconds)|`refreshSilenceTimeoutMs`|`5000`|5 sec
|Console logger|Verbosity|`verbosity`|`EVerbosity.Full` (`"full"`)|The most verbose output level
|File logger|Verbosity|`verbosity`|`EVerbosity.Full` (`"full"`)|The most verbose output level
|File logger|Log path|`logPath`|`"__pflogs"`|-
|File logger|Archive path|`archivePath`|`"__pfarchive"`|-
|File logger|Max log size (in bytes)|`maxLogSizeBytes`|`0`|Log archiving is disabled
|File logger|Max archive size (in bytes)|`maxArchiveSizeBytes`|`0`|Only the most recent archive file is kept
|File logger|Log request archiving modulo|`logRequestArchivingModulo`|`25`|If enabled (max log size is larger than 0), log archiving will be attempted every 25 log requests; a log archiving attempt consists of comparing the cumulative log size to `maxLogSizeBytes` and performing archiving if comparing the cumulative log size is larger
|File logger|Source key|`sourceKey`|`""`|-
|Data collector|Sort column|`sortColumn`|`"maxMs"`|-
|Data collector|Flush delay (in milliseconds)|`flushDelayMs`|`0`|No additional delay when flushing data queues
|Data collector server|Host|`host`|`"0.0.0.0"`|Listen on all network interfaces
|Data collector server|Port|`port`|`9666`|-
|Data collector server, file logger|Verbosity|`verbosity`|`EVerbosity.Full` (`"full"`)|The most verbose output level
|Data collector server, file logger|Log path|`logPath`|`"__pflogs"`|-
|Data collector server, file logger|Archive path|`archivePath`|`"__pfarchive"`|-
|Data collector server, file logger|Max log size (in bytes)|`maxLogSizeBytes`|`200 * 1024 * 1024`|200MB
|Data collector server, file logger|Max archive size (in bytes)|`maxArchiveSizeBytes`|`1024 * 1024 * 1024`|1GB
|Data collector server, file logger|Log request archiving modulo|`logRequestArchivingModulo`|`100`|If enabled (max log size is larger than 0), log archiving will be attempted every 100 log requests; a log archiving attempt consists of comparing the cumulative log size to `maxLogSizeBytes` and performing archiving if comparing the cumulative log size is larger
|Data collector server, file logger|Source key|`sourceKey`|`""`|-
|Data collector server, data collector|Sort column|`sortColumn`|`"maxMs"`|-
|Data collector server, data collector|Flush delay (in milliseconds)|`flushDelayMs`|`0`|No additional delay when flushing data queues

GETTING STARTED
==================================================
Here is a very simple NodeJS application implementing a single profiling hit point:

    const { __pf, __pfconfig, __pfenabled, __pfbegin, __pfend } = require("raw-profiler");
    const _sleep = ms => new Promise(f => setTimeout(f, ms));

    console.log("[raw-profiler] profiler initial config\n" + __pf.instance.printConfigurationLines());

    async function test()
    {
        let hit, err;
        if (__pfenabled())
        {
            __pflog("TEST BUCKET", "Log line text");
            hit = __pfbegin("TEST BUCKET", "User [_id, active]", "profiling hit text");
        }
        try
        {
            //  although _sleep is never exptected to throw an exception, this code is provided as a template for real-world profiling scenarios and nevertheless demonstrates exception logging
            await _sleep(1000);
        }
        catch (ex)
        {
            err = ex;
        }
        if (__pfenabled())
        {
            const postfix = err ? "; error=" + err : "";
            hit = __pfend(hit, postfix);
        }
    }
    test();

COMMON CONFIGURATIONS
==================================================

The examples below illustrate how to configure the profiler in miscellaneous usage scenarios. Setting up profiling hit points is covered in next sections.

Configure `raw-profiler` for Local Console Logging
--------------------------------------------
_Appropriate for simple profiling scenarios with a single bucket._

In the application main file (e.g. app.js), add

    require("raw-profiler").global();

Configure `raw-profiler` for Local Logging to the File System
--------------------------------------------
_Appropriate for profiling scenarios with multiple buckets under lower server loads._

In the application main file (e.g. app.js), add

    require("raw-profiler").global();
    __pfconfig({ logger: __pf.DefaultFileLogger });

    //	will use __pf.DefaultFileLogger and store the profiler output in the ~/__pflogs directory

In the application main file (e.g. app.js), add

    require("raw-profiler").global();
    __pfconfig(
    {
        dataCollector:
        {
            type: "DataCollector",
            config:
            {
                logger: __pf.DefaultFileLogger,
                flushDelayMs: 4000
            }
        }
    });

    //	will use __pf.DefaultFileLogger and store the profiler output in the ~/__pflogs directory; will flush the output 4 seconds after a new entry has been enqueued to an empty log queue
    //  with a constant flow of logging data, `flushDelayMs: 4000` will effectively cause the file system logger to flush the accumulated data roughly every 4 seconds

To create a file logger with custom params, use

    require("raw-profiler").global();
	__pfconfig(
    {
        logger: 
	    {
            type: "FileLogger",
            config:
            {
    		    sourceKey: "MyAppInstance",
		        logPath: "/var/logs/raw-profiler",
		        maxLogSizeBytes: 1024 * 1024,
		        maxArchiveSizeBytes: 200 * 1024 * 1024
            }
	    }
    });

    //  will store the profiler output in the /var/logs/raw-profiler/MyAppInstance directory
    //  the output won't be delayed but will be still written by a `setTimeout(..., 0)` callback
    //  will monitor the total size of all *.log files, generated by the current profiling session
    //      when the total size exceeds 1024 * 1024 bytes (1Mb), all accumulated *.log files will be moved to a zip-file
    //  will monitor the total size of all *.zip files in the archive directory
    //      when the total size exceeds 200 * 1024 * 1024 bytes (200Mb), the oldest archive files will be removed so that the total archive size is less than maxArchiveSizeBytes

Configure `raw-profiler` for Remote Logging
--------------------------------------------
_Appropriate for profiling scenarios with heavy server loads._

In the application main file (e.g. `app.js`), add

    const { DataCollectorHttpProxy } = require("raw-profiler").global();
    __pfconfig(
    {
        dataCollector:
        {
		    type: "DataCollectorHttpProxy",
		    config:
		    {
                uri: "http://127.0.0.1:9666/feed",
                sourceKey: "node1",
                requestTimeoutMs: 5000,
                failureTimeoutMs: 60000,
		    }
	    }
    });

    //	will proxy the stats to a remote server
    //  will timeout outgoing logging requests in 5000 ms (default is 2000 ms)
    //	the remote server will append "-node1" to the name of the subdirectory that will strore the logs from this particular application instance
    //	    allowing one logging server to collect data from many application running instances


_NOTE: The data collection proxy accepts a `sourceKey` parameter. If `sourceKey` is set, the data collection server will append a stripped version of this string to the logging subdirectory, e.g. it will use `127.0.0.1-development` instead of the plain `127.0.0.1`._

To start the remote profiling data collector server, create a new `app.js` file, like this

    require("raw-profiler").global();
    __pf.createDataCollectorServer({host: "0.0.0.0", port: 9666, dataCollector: { flushDelayMs: 300 } }).run();

Configuring the logger (all file logger properties are supported along with `logPath`):

    require("raw-profiler").global();
    __pf.createDataCollectorServer({host: "0.0.0.0", port: 9666, fileLogger: { logPath: "/var/log/raw-profiler" } }).run();

In order to perform custom feed source detection, run the remote profiling data collector server like this

     require("raw-profiler").global();
     __pf.createDataCollectorServer({host: "0.0.0.0", port: 9666, dataCollector: { flushDelayMs: 300 } }).run(function(req, res)
     {
        return req.headers["x-forwarded-for"] ||
            req.headers["x-real-ip"] ||
            req.connection.remoteAddress ||
            req.socket.remoteAddress ||
            req.connection.socket.remoteAddress;
     });


Automatic Log File Compression and Archiving with Local Profiling
--------------------------------------------
Intensive profling tends to generate huge logs, which could easily reach gigabytes per hour in production environments. Enabling the automatic log file compression and archiving
mitigates this effect to some extent.

To enable the automatic log file compression and archiving for local profiling, specify the `maxLogSizeBytes` parameter for the file logger (`0` - disabled; `> 0` - enabled). 
In the application main file (e.g. `app.js`), add

    require("raw-profiler").global();
    __pfconfig(
    { 
        dataCollector:
        {
            type: "DataCollector",
            config:
            {
                logger:
                {
                    type: "FileLogger",
                    config: { maxLogSizeBytes: 1024 * 1024 } 
                },
                flushDelayMs: 4000
            }
        }
    });

    //  will monitor the total size of all *.log files, generated by the current profiling session
    //      when the total size exceeds 1024 * 1024 bytes (1Mb), all accumulated *.log files will be moved to a zip-file


The file logger may be instructed to store the raw log files in a custom directory by providing an absolute path or a path, relative to the home directory of the user who runs the app:

    require("raw-profiler").global();
    __pfconfig(
     {
         dataCollector:
         {
             type: "DataCollector",
             config:
             {
                 logger:
                 {
                     type: "FileLogger",
                     config:
                     {
                         logPath: "/var/logs/raw-profiler",
                         maxLogSizeBytes: 1024 * 1024
                     }
                 },
                 flushDelayMs: 4000
             }
         }
    );


The file logger is able to prevent the total archive size from exceeding a certain value (by automatically deleting oldest archive (`*.zip`) files):

    require("raw-profiler").global();
    __pfconfig(
    {
        logger:
        {
            type: "FileLogger",
            config:
            {
                logPath: "/var/logs/raw-profiler",
                maxLogSizeBytes: 1024 * 1024,
                maxArchiveSizeBytes: 10 * 1024 * 1024
            }
        }
    });

    //  will create a new DataCollector instance
    //	will set the max uncompressed log size to 1Mb
    //	will set the max archive size to 10Mb


Automatic Log File Compression and Archiving with Remote Profiling
--------------------------------------------
_See also the previous section._ The automatic log file compression and archiving is enabled by default on the profiling data collector server, with `maxLogSizeBytes` set to `200Mb`.


To change the `maxLogSizeBytes` value, create the profiling data collector server `app.js` file using:

    require("raw-profiler").global();
    __pf.createDataCollectorServer({ host: "0.0.0.0", port: 9666, dataCollector: { flushDelayMs: 300 }, fileLogger: { maxLogSizeBytes: 500 * 1024, maxArchiveSizeBytes: 10 * 1024 * 1024 } }).run();

    //	will set the max uncompressed log size to 500Kb
    //	will set the max archive size to 10Mb


The profiling data collection server may be instructed to store the raw log files in a custom directory by providing an absolute path or a path, relative to the home directory of 
the user who runs the app:

    require("raw-profiler").global();
    __pf.createDataCollectorServer({host: "0.0.0.0", port: 9666, dataCollector: { flushDelayMs: 300 }, fileLogger: { logPath: "/var/logs/raw-profiler" } }).run();

    //	will use /var/logs/raw-profiler to store current log files


Automatic Log File Compression and Archiving - Remarks
--------------------------------------------

To enable automatic log file compression and archiving, configure the file logger with `maxLogSizeBytes > 0` and `logRequestArchivingModulo > 0`. Automatic log file compression 
and archiving changes the file logger behavior the following way:

* All log files are prefixed with a 14-digit timestamp followed by a dash (e.g. `01689840005906-REST.log`), i.e. the naming of the log files changes from `~/__pflogs/[<app-server-ip>-<source-key>/]bucketKey1.log` to `~/__pflogs/[<app-server-ip>-<source-key>/]<timestamp>-bucketKey1.log`.
* The current timestamp is used as a name for the next archive zip-file as well (the name of the zip-file is the same as the timestamps of the archived log files). The zip file names can be used for sorting (zip-files with larger numbers in names are generated later).
* Any log files prefixed by a timestamp different from the current timestamp are considered orphans and are archived in a zip file named `<timestamp>-orphaned.zip`, where `<timestamp>` is 
generated based on the current time at the moment of archiving (the name of the zip-file is different from the timestamps of the archived orphaned log files).
* The timestamp is generated when the file logger object is first created and is regenerated every time the currently accumulated log files are archived.

Placing Profiling Hit Points In Code
--------------------------------------------
In the code, use `__pfbegin` and `__pfend` to profile

    let hit = __pfbegin("bucketKey1", "key1" [, "text"]);
    ... //	synchronous or asynchronous code
    hit = __pfend(hit [, " append to text"]);   //  __pfend always returns null; assigning null to hit helps to prevent reusing the hit's state by mistake after its lifetime has ended


Use `if(__pfenabled("<bucketKey>")) {...  /* profiling code */ }` to prevent large portions of profiling code from executing when profiling is disabled (usually code that builds profiler 
keys), e.g.

    let hit, err;
    if(__pfenabled("CRUD"))
    {
        const sb = [];
        sb.push("READ");
        sb.push(collectionName);
        sb.push(__pf.utility.getKeysText(query));
        hit = __pfbegin("CRUD", sb.toString(" "), "query=" + query);
    }
    try
    {
        //  ... code to be profiled
    }
    catch(ex)
    {
        err = ex;
    }
    if(__pfenabled())
    {
        hit = __pfend(hit, err ? "; error=" + err : "");   //  __pfend always returns null; assigning null to hit helps to prevent reusing the hit's state by mistake after its lifetime has ended
    }

Don't put the `__pfend` call in a `finally` block unless you're sure that `__pfflush` will executed before the application exits due to an unhandled exception. Otherwise the profiling hit that fires the exception won't be logged because the application will exit before data collecting queues have been flushed.

To aid building schema-specific profiling keys for `__pfbegin`, use

	const keysText = __pf.utility.getKeysText(data);   //	if data == {a: 1, b: {c: 1}}, keysText will be "a,b"


`keysText` can be appended to profiling keys to add schema specificity, for Ex., when profiling CRUD operations, one could build the profiling key by combining the 
_db operation type_ (read, insert...), the _db collection name_ and the result of a `getKeysText`, e.g.:

    "READ calendar_event [event_type,user]"


`__pfbegin` may be used also for logging. To strip sensitive data from a javascript object you would like to append to the log, you can use `__pf.utility.stripStringify(obj, stripFieldNames)`:

	__pf.utility.stripStringify(data, ["password", "deletedObject.password"]);


This function accepts both objects and arrays as its first argument. It sets all designated fields to `"(stripped by raw-profiler)"` and returns a `JSON.stringify` of the object. 
`__pf.utility.stripStringify` does not modify the original object.


Enabling and Disabling the Profiler (file: `__pfenable`)
--------------------------------------------
The profiler can be enabled and disabled without restarting the application server. To enable profiling, create the file `~/__pfenable` on the application server, 
to disable profiling, delete/rename the file `~/__pfenable`.


Changing Profiler Preferences at Runtime (file: `__pfconfig`)
--------------------------------------------
The profiler's runtime preferences are loaded from the `~/__pfconfig` file. To edit the runtime preferences use the command

	nano ~/__pfconfig


CONFIGURATION REFERENCE
==================================================

__pfconfig
---------------------------
```
//	Function: `__pfconfig(par: object): void` - Reconfigures the `Profiler` single instance.
//	Parameter:
//	```
//		par:
//		{
//			commandFilePath: string,			//	optional, defaults to "__pfenable"; the path to the runtime command file for raw-profiler, e.g. /home/user/__pfenable; the existance of the command file determines the enabled state of the raw-profiler; if there is no such file, the raw-profiler functionality is completely disabled except for testing for the command file existence.
//			configurationFilePath: string,		//	optional, defaults to "__pfconfig"; the path to the runtime configuration file for raw-profiler, e.g. /home/user/__pfconfig.
//			refreshSilenceTimeoutMs: uint,		//	optional, defaults to 5000; run-time configuration refresh-from-file attempts will be performed no more frequently than once every refreshSilenceTimeoutMs milliseconds.
//			initialEnabled: boolean,			//	optional, defaults to true; provides an initial value for the profiler enabled state before the command file has been queried for the first time.
//
//			create(className, config): object,	//	optional; if set will be called whenever a non-standard data collector or logger need to be created (see par.dataCollector.type and par.dataCollector.logger.type).
//			dataCollector:						//	optional, if not set __pf.DefaultDataCollector is used; configuration for a new data collector instance; if the provided value has no type propery, this value is assumed to be a data collector instance.
//			{
//				type: string,					//	optional, defaults to "DataCollector"; the class name to instanciate a new data collector from; can be "DataCollector", "DataCollectorHttpProxy" or a custom data collector; if a custom name is provided, a `par.create` callback must be provided as well that knows how to create a data collector instance based on this name.
//				config:							//	optional
//				{
//					//	with DataCollector
//					runtimeInitial:				//	optional; DataCollector uses the values specified as properties to this object as initial configuration.
//					{
//						sortColumn: string,		//	optional, defaults to "maxMs"
//						"buckets.*": ...		//	optional; a mechanism to specify initial/default values foir the buckets runtime configuration that is loaded later from `__pfconfig`.
//					},
//					logger:						//	optional, if not set __pf.DefaultConsoleLogger is used; configuration for a logger instance; if the provided value has no type propery, this value is assumed to be a logger instance.
//					{
//						type: string,			//	optional, defaults to "ConsoleLogger"; the class to instanciate a new logger from; can be "ConsoleLogger", "FileLogger" or a custom class/object implementing { logBuckets: function }; if a custom name is provided, a `par.create` callback must be provided as well that knows how to create a logger instance based on this name.
//						config:					//	optional
//						{
//							//	with ConsoleLogger
//							runtimeInitial:							//	optional; ConsoleLogger uses the values specified as properties to this object as initial configuration.
//							{
//								verbosity: string,					//	optional; ConsoleLogger uses the values specified as properties to this object as initial configuration.
//							},
//
//							//	with FileLogger
//							runtimeInitial:							//	optional; FileLogger uses the values specified as properties to this object as initial configuration.
//							{
//								verbosity: EVerbosity,				//	optional, defaults to `EVerbosity.Full`
//								logPath: string,					//	optional, defaults to `"__pflogs"`
//								archivePath: string,				//	optional, defaults to `"__pfarchive"`
//								maxLogSizeBytes: uint,				//	optional, defaults to `0` (disabled); use `0` to disable log archiving
//								maxArchiveSizeBytes: uint,			//	optional, defaults to `0` (disabled); use `0` to disable archive collection trimming
//								logRequestArchivingModulo: uint,	//	optional, defaults to `25`
//								sourceKey: string,					//	optional, defaults to `""`
//							},
//						},
//					},
//					flushDelayMs: uint,					//	optional, defaults to 0; used as a parameter for a setTimeout before flushing the queues.
//
//					//	with DataCollectorHttpProxy
//					runtimeInitial:						//	required; DataCollectorHttpProxy uses the values specified as properties to this object as initial configuration.
//					{
//						uri: string,					//	required; DataCollectorHttpProxy will forward profiling data by sending HTTP requests to this endpoint until overwritten by the runtime configuration.
//						sourceKey: string,				//	required; this key is used by the remote logging server as part of the log file paths allowing for multiple application servers to feed data to a single logging server until overwritten by the runtime configuration.
//						requestTimeoutMs: uint,			//	required; specifies a timeout for HTTP requests before abortion until overwritten by the runtime configuration.
//						failureTimeoutMs: uint,			//	required; specifies the time between reporting repeated HTTP request failures until overwritten by the runtime configuration.
//						"buckets.*": ...				//	optional; a mechanism to specify initial/default values foir the buckets runtime configuration that is loaded later from `__pfconfig`.
//					},
//				},
//			},
//		}
//	```
//	Alternative form - `par.logger` instead of `par.dataCollector` (assumes a data collector of type "DataCollector")
//	```
//		par:
//		{
//			...
//			logger:						//	optional, if not set __pf.DefaultConsoleLogger is used; configuration for a logger instance; if the provided value has no type propery, this value is assumed to be a logger instance
//			{
//				type: string,			//	optional, defaults to "ConsoleLogger"; the class to instanciate a new logger from; can be "ConsoleLogger", "FileLogger" or a custom class/object implementing { logBuckets: function }.
//				config:					//	optional
//				{
//					//	with ConsoleLogger
//					runtimeInitial:							//	optional; ConsoleLogger uses the values specified as properties to this object as initial configuration.
//					{
//						verbosity: string,					//	optional; ConsoleLogger uses the values specified as properties to this object as initial configuration.
//					},
//
//					//	with FileLogger
//					runtimeInitial:							//	optional; FileLogger uses the values specified as properties to this object as initial configuration.
//					{
//						verbosity: EVerbosity,				//	optional, defaults to `EVerbosity.Full`
//						logPath: string,					//	optional, defaults to `"__pflogs"`
//						archivePath: string,				//	optional, defaults to `"__pfarchive"`
//						maxLogSizeBytes: uint,				//	optional, defaults to `0` (disabled); use `0` to disable log archiving
//						maxArchiveSizeBytes: uint,			//	optional, defaults to `0` (disabled); use `0` to disable archive collection trimming
//						logRequestArchivingModulo: uint,	//	optional, defaults to `25`
//						sourceKey: string,					//	optional, defaults to `""`
//					},
//				},
//			},
//		}
//	```
```

__pf.createDataCollectorServer
---------------------------
```
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
```

Run-time configuration
---------------------------
Sample config file illustrating all possible configuration fields:

	{
		"sortColumn": "totalMs",                    //  the default sorting column for all profiling buckets; can be overridden per profiling bucket; only used with a DataCollector data collector
        "logger":
        {
		    "verbosity": "brief",
            "logPath": "/var/logs/node1",           //  only used with a FileLogger
		    "archivePath": "/media/archive",        //  only used with a FileLogger
		    "maxLogSizeBytes": 10000000,            //  only used with a FileLogger
		    "maxArchiveSizeBytes": 1000000000,      //  only used with a FileLogger
		    "logRequestArchivingModulo": 100,       //  only used with a FileLogger
        },
        "proxy":                                    //  only used with a DataCollectorHttpProxy data collector
        {
            "uri": "http://127.0.0.1:9666/feed",
            "sourceKey": "node1",
            "requestTimeoutMs": 5000,
            "failureTimeoutMs": 60000,
        },
		"buckets":
		{
			"myBucket":
			{
				"enabled": false,                   //  used by both DataCollector and DataCollectorHttpProxy data collector; with DataCollectorHttpProxy (remote logging), allows for disabling profiling buckets also locally at the node application
				"sortColumn": "total",              //  only used with a DataCollector data collector
			},
			"myBucket2":
			{
				"sortColumn": "total",              //  only used with a DataCollector data collector
			}
		}
	}

`sortColumn` possible values (see **STATS TABLE COLUMNS** below fo details):

        count
        discrepancy
        minMs
        avgMs
        maxMs (default)
        totalSec
        totalMs
        avgCpu
        minAvgOsCpu
        avgAvgOsCpu
        maxAvgOsCpu

`verbosity` possible values:

- `EVerbosity.Full = "full" -> default` - will print full profiling stats for each profiling hit
- `EVerbosity.Brief = "brief"` - will print tables with summary and info only for the current profiling hit key
- `EVerbosity.Log = "log"` - won't print tables, only timestamped titles

By default all buckets are enabled, and all buckets use the default sorting column.

_NOTE: The runtime configuration file (usually `~/__pfconfig`) is reloaded asynchronously on profiling hit, but no more often than once every 5 seconds (configurable via `__pfconfig({ refreshSilenceTimeoutMs: <value> })`).
As a consequence, changes are read only on the next profiling hit, and there is a delay between reading the configuration changes and the changes coming into effect._


READING LOCAL PROFILING RESULTS
==================================================

- Enable profiling for the first time (works both on the application server and the logging server)

		user@appServer$ touch ~/__pfenable

- Disable profiling (works both on the application server and the logging server)

		user@appServer$ mv ~/__pfenable ~/__pfenable.not

- Reenable profiling (works both on the application server and the logging server)

		user@appServer$ mv ~/__pfenable.not ~/__pfenable

- Monitor bucket output with local profiling

		user@appServer$ watch cat ~/__pflogs/bucketKey1.now

- See full profiling history with local profiling

		user@appServer$ less ~/__pflogs/bucketKey1.log
		or
		user@appServer$ less ~/__pflogs/<timestamp>-bucketKey1.log       # with automatic log file compression and archiving

- Change current sorting column

		user@appServer$ nano ~/__pfconfig


READING REMOTE PROFILING RESULTS
==================================================

- Monitor bucket output with remote profiling

		user@profilingServer$  watch cat ~/__pflogs/<app-server-ip>-<source-key>/bucketKey1.now


- See full profiling history with remote profiling

		user@profilingServer$ less ~/__pflogs/<app-server-ip>-<source-key>/bucketKey1.log
		or
		user@profilingServer$ less ~/__pflogs/<app-server-ip>-<source-key>/<timestamp>-bucketKey1.log       # with automatic log file compression and archiving


- Change current sorting column

		user@profilingServer$ $ nano ~/__pfconfig

STATS TABLE COLUMNS
==================================================

- `key` - unique profiling key; stats are collected per profiling key
- `count` - the count of profile hits for the specified key; _sorting column name: `count`_
- `d.` - "discrepancy". values other than 0 indicate incidents of a profiling hit point that has been hit, but never ended (the corresponding `__pfend` has not been calld yet); the value represents the number of such pending hits; it's normal to see such indications from time to time appear and disappear; a problem could be recognized, if such indications last for longer times; _sorting column name: `discrepancy`_
- `minms` - the shortest execution time for the specified key on record; _sorting column name: `minMs`_
- `avgms` - the average execution time for the specified key since the profiling has started; _sorting column name: `avgMs`_
- `maxms` - the longest execution time for the specified key on record; _sorting column name: `maxMs`_
- `totalms` - the total execution time for the specified key since the profiling has started; _sorting column names: `totalSec`, `totalMs`_
- `max event time` - the timepoint at which the value from `maxms` was recorded
- `CPU%` - the load of the OS CPU during the hit duration; if multiple CPUs are reported by the OS, the highest value is taken; it is normal for this value to be close to 100% - this means that during the profiling hit the application's main thread did not wait; _sorting column name: `avgCpu`_
- `minCPU%` - the minimum OS CPU load, measured for the last 1 minute at the end of a profiling hit for the specified key (this value has no direct relation to the `CPU%` value); _sorting column name: `minAvgOsCpu`_
- `avgCPU%` - the average OS CPU load, measured for the last 1 minute since the profiling has started for the specified key (this value has no direct relation to the `CPU%` value); _sorting column name: `avgAvgOsCpu`_
- `maxCPU%` - the maximum OS CPU load, measured for the last 1 minute at the end of a profiling hit for the specified key (this value has no direct relation to the `CPU%` value); _sorting column name: `maxAvgOsCpu`_

SUBHEADER TABLE COLUMNS
==================================================

The profiler counts all profiling hits globally (**N**) and locally (per profiling key, **LN**). It also keeps track of all currently **open** hits, i.e. hits that did start but did not end yet.

- `delta LN` - how many other hits of the same profiling key occured during the current hit's lifespan
- `->LN` - the local hit count at the time the current hit started
- `LN->` - the local hit count at the time the current hit ended
- `delta N` - how many other hits of any profiling key occured during the current hit's lifespan
- `->N` - the global hit count at the time the current hit started
- `N->` - the global hit count at the time the current hit ended
- `delta open` - the delta between the `->open` and `open->` values
- `->open` - how many hits have stared but haven't ended when the current hit started
- `open->` - how many hits have stared but haven't ended when the current hit ended
- `duration` - the duration of the current profiling hit
- `CPU%` - the average OS CPU load during profiling hit's execution (100% is ok, this means that the application hasn't waited during the hit); this value is not indicative of the performance of
    the code being profiled by the current profiling hit point

NOTES
==================================================

- All file paths used by the profiler are relative to the home directory of the user who runs the application.
- All functions used for profiling (`__pfbegin`, `__pfend`, `__pfenabled`) are synchronous.
- Writing logs and sending logs to a remote logging server are asynchronous operations.
- Disabling the profiler by deleting/renaming the file `~/__pfenable` will retain all profiling stats and won't delete the `*.log` and `*.now` files. Enabling the profiler will continue from where you left it off.
- Enabling and disabling the profiler via `~/__pfenable` works only on the application server and not on the remote data collector server. On the remote data collector server the `~/__pfenable` file is ignored.
    - NOTE: This behavior will change with adding the remote configuratrion feature.
- With local profiling, the loggers use the sorting column, specified in `~/__pfconfig` on the **application** server.
- With remote profiling, the loggers use the sorting column, specified in `~/__pfconfig` on the **remote data collector server** (in which case the app server sorting column preference is ignored).
- Multiple applications/node instances can feed into the same data collector server; different sources will be differentiated based on the feed source server's IP, combined with the `sourceKey` setting of the corresponding application server.
- The profiler rereads the configuration file on every profiling hit but no more than once every 5 seconds (configurable).
- The __pf* public methods never throw exceptions (all exceptions are logged to the console instead).

TODO
==================================================

- Documentation
    - Generate API reference from code comments.
	- Add a "HOW TO EXTEND" documentation topic.
    - Convert the NOTES section to elaborate documentation.
- Known problems
	- Orphaned file archives can have too recent time signatures in the names, which breaks archive file sorting; the desired behavior would be to group orphaned log files by timestamp into multiple archives, e.g. `<orphan-timestamp>-<current-timestamp>-orphans.zip`

LICENSE
==================================================

MIT/X Consortium License _(see the included LICENSE file)_.

BUG REPORTS
==================================================

For bug reports and suggestions use https://github.com/falaelcom/raw-profiler/issues. For direct contact with the developer send an email to <daniel@falael.com>.

