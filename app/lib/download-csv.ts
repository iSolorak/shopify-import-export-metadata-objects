// Browser-side CSV download, shared by both export pages.
//
// Exports cannot be plain links. A link inside the embedded app is a
// client-side navigation, and the export routes are resource routes with no
// component — React Router would render an empty page instead of downloading.
// Fetching the CSV and handing the browser a blob keeps us on the current page.

/** The filename the server picked, so a download does not have to guess it. */
function filenameFrom(contentDisposition: string | null) {
  const match = contentDisposition?.match(/filename="?([^";]+)"?/);
  return match?.[1];
}

/**
 * Hand the browser a string to save as a file.
 *
 * Split out from `downloadCsv` for the pages that build their CSV from an
 * upload rather than fetching it: the file only exists as the response to a
 * POST carrying the source data, so there is no URL to point a download at.
 */
export function saveCsv(text: string, filename: string) {
  // The BOM is what makes Excel read the file as UTF-8 rather than mangling
  // every accented character, matching what the export routes send.
  const blob = new Blob(["﻿" + text], {
    type: "text/csv;charset=utf-8",
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoking straight away cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export async function downloadCsv(url: string) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      (await response.text()) || `Export failed with status ${response.status}`,
    );
  }

  // A session that expired mid-visit answers with an auth redirect rather than
  // a file. Saving that HTML as a .csv would be a confusing way to find out.
  if (!response.headers.get("Content-Type")?.includes("text/csv")) {
    throw new Error("Session expired. Reload the app and try again.");
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download =
    filenameFrom(response.headers.get("Content-Disposition")) ?? "export.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoking straight away cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
