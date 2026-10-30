import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertCompleteProjectPublisherSource } from './project-publisher-contract.mjs'

test('first-file release declares complete publishers without runtime source rewriting', () => {
  assertCompleteProjectPublisherSource(readFileSync(new URL('../../supabase/migrations/20261029114000_project_first_file_policy.sql', import.meta.url), 'utf8'))
})
