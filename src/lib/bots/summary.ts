/**
 * The marker LangChain's summarization middleware puts on its summary message
 * (`additional_kwargs.lc_source`) and on the events of the summarizing model
 * call. Dependency-free so routes and the stream converter can read it.
 */
export const SUMMARIZATION_SOURCE = 'summarization';

/** Shown in a reloaded bot thread where older turns were summarized. */
export const SUMMARY_MARKER_TEXT =
  '_Earlier messages in this thread were summarized to keep it within the model’s context._';
