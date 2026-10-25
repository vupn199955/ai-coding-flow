'use client';

import { useId, useRef, useState } from 'react';
import { ArrowUpRight, FolderGit2, LoaderCircle, X } from 'lucide-react';
import type { DirectoryListing } from '@ai-flow/shared';

export function FolderPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [location, setLocation] = useState(value);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const browse = async (directory: string) => {
    const current = ++sequence.current;
    setLoading(true);
    setListing(null);
    setError('');
    try {
      const response = await fetch(
        `/api/directories${directory ? `?path=${encodeURIComponent(directory)}` : ''}`,
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Cannot read this folder.');
      if (current === sequence.current) {
        setListing(result);
        setLocation(result.path);
      }
    } catch (cause) {
      if (current === sequence.current) setError((cause as Error).message);
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  };
  return (
    <div className="form-field">
      <label htmlFor={id}>Repository path</label>
      <div className="folder-input">
        <input
          id={id}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="/Users/you/projects/my-app"
        />
        <button
          type="button"
          className="button secondary small"
          onClick={() => {
            setOpen(true);
            void browse(value);
          }}
        >
          <FolderGit2 size={15} />
          Browse folder
        </button>
      </div>
      {open && (
        <div className="folder-browser">
          <div className="folder-toolbar">
            <input
              aria-label="Browse location"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void browse(location);
                }
              }}
            />
            <button
              type="button"
              className="button secondary small"
              onClick={() => void browse(location)}
            >
              Go
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Close folder browser"
              onClick={() => {
                sequence.current++;
                setOpen(false);
              }}
            >
              <X size={16} />
            </button>
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <p role="status">
              <LoaderCircle size={15} className="spin" /> Loading folders…
            </p>
          ) : (
            listing && (
              <>
                <div className="folder-entries">
                  {listing.parent && (
                    <button type="button" onClick={() => void browse(listing.parent!)}>
                      <ArrowUpRight size={15} />
                      Parent folder
                    </button>
                  )}
                  {listing.directories.map((directory) => (
                    <button
                      type="button"
                      key={directory.path}
                      onClick={() => void browse(directory.path)}
                    >
                      <FolderGit2 size={15} />
                      {directory.name}
                    </button>
                  ))}
                  {!listing.directories.length && <p>No subfolders.</p>}
                </div>
                <button
                  type="button"
                  className="button primary small"
                  onClick={() => {
                    onChange(listing.path);
                    setOpen(false);
                  }}
                >
                  Select this folder
                </button>
                <small>{listing.path}</small>
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}
