export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      absence_decisions: {
        Row: {
          absence_record_id: string
          corrected_absence_type_id: string | null
          created_at: string
          decided_at: string
          decided_by: string
          decision_status: string
          document_deadline: string | null
          document_required: boolean
          id: string
          is_current: boolean
          reason: string | null
        }
        Insert: {
          absence_record_id: string
          corrected_absence_type_id?: string | null
          created_at?: string
          decided_at?: string
          decided_by?: string
          decision_status: string
          document_deadline?: string | null
          document_required?: boolean
          id?: string
          is_current?: boolean
          reason?: string | null
        }
        Update: {
          absence_record_id?: string
          corrected_absence_type_id?: string | null
          created_at?: string
          decided_at?: string
          decided_by?: string
          decision_status?: string
          document_deadline?: string | null
          document_required?: boolean
          id?: string
          is_current?: boolean
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "absence_decisions_absence_record_id_fkey"
            columns: ["absence_record_id"]
            isOneToOne: false
            referencedRelation: "absence_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_decisions_corrected_absence_type_id_fkey"
            columns: ["corrected_absence_type_id"]
            isOneToOne: false
            referencedRelation: "absence_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      absence_records: {
        Row: {
          absence_type_id: string
          created_at: string
          created_by: string | null
          employee_id: string
          end_date: string
          external_id: string | null
          id: string
          is_current: boolean
          source: string
          source_hash: string
          source_updated_at: string | null
          source_version: number
          start_date: string
          sync_run_id: string | null
          synced_at: string
        }
        Insert: {
          absence_type_id: string
          created_at?: string
          created_by?: string | null
          employee_id: string
          end_date: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          source?: string
          source_hash: string
          source_updated_at?: string | null
          source_version?: number
          start_date: string
          sync_run_id?: string | null
          synced_at?: string
        }
        Update: {
          absence_type_id?: string
          created_at?: string
          created_by?: string | null
          employee_id?: string
          end_date?: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          source?: string
          source_hash?: string
          source_updated_at?: string | null
          source_version?: number
          start_date?: string
          sync_run_id?: string | null
          synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "absence_records_absence_type_id_fkey"
            columns: ["absence_type_id"]
            isOneToOne: false
            referencedRelation: "absence_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_records_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_records_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      absence_types: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      attendance_corrections: {
        Row: {
          attendance_record_id: string
          corrected_at: string
          corrected_by: string
          corrected_by_role: Database["public"]["Enums"]["app_role"] | null
          corrected_clock_in: string | null
          corrected_clock_out: string | null
          correction_type: string | null
          created_at: string
          employee_id: string
          id: string
          is_current: boolean
          reason: string
          work_date: string
        }
        Insert: {
          attendance_record_id: string
          corrected_at?: string
          corrected_by?: string
          corrected_by_role?: Database["public"]["Enums"]["app_role"] | null
          corrected_clock_in?: string | null
          corrected_clock_out?: string | null
          correction_type?: string | null
          created_at?: string
          employee_id: string
          id?: string
          is_current?: boolean
          reason: string
          work_date: string
        }
        Update: {
          attendance_record_id?: string
          corrected_at?: string
          corrected_by?: string
          corrected_by_role?: Database["public"]["Enums"]["app_role"] | null
          corrected_clock_in?: string | null
          corrected_clock_out?: string | null
          correction_type?: string | null
          created_at?: string
          employee_id?: string
          id?: string
          is_current?: boolean
          reason?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_corrections_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_effective_punches"
            referencedColumns: ["attendance_record_id"]
          },
          {
            foreignKeyName: "attendance_corrections_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_corrections_corrected_by_fkey"
            columns: ["corrected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_corrections_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_missing_punch_flags: {
        Row: {
          attendance_record_id: string
          contacted_at: string | null
          contacted_by: string | null
          created_at: string
          employee_id: string
          id: string
          missing_type: Database["public"]["Enums"]["missing_punch_type"]
          notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: Database["public"]["Enums"]["missing_punch_status"]
          updated_at: string
          work_date: string
        }
        Insert: {
          attendance_record_id: string
          contacted_at?: string | null
          contacted_by?: string | null
          created_at?: string
          employee_id: string
          id?: string
          missing_type: Database["public"]["Enums"]["missing_punch_type"]
          notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["missing_punch_status"]
          updated_at?: string
          work_date: string
        }
        Update: {
          attendance_record_id?: string
          contacted_at?: string | null
          contacted_by?: string | null
          created_at?: string
          employee_id?: string
          id?: string
          missing_type?: Database["public"]["Enums"]["missing_punch_type"]
          notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["missing_punch_status"]
          updated_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_missing_punch_flags_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: true
            referencedRelation: "attendance_effective_punches"
            referencedColumns: ["attendance_record_id"]
          },
          {
            foreignKeyName: "attendance_missing_punch_flags_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: true
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_missing_punch_flags_contacted_by_fkey"
            columns: ["contacted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_missing_punch_flags_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_missing_punch_flags_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_records: {
        Row: {
          actual_clock_in: string | null
          actual_clock_out: string | null
          created_at: string
          employee_id: string
          external_id: string | null
          id: string
          is_current: boolean
          source: string
          source_hash: string
          source_updated_at: string | null
          source_version: number
          sync_run_id: string | null
          synced_at: string
          work_date: string
        }
        Insert: {
          actual_clock_in?: string | null
          actual_clock_out?: string | null
          created_at?: string
          employee_id: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          source?: string
          source_hash: string
          source_updated_at?: string | null
          source_version?: number
          sync_run_id?: string | null
          synced_at?: string
          work_date: string
        }
        Update: {
          actual_clock_in?: string | null
          actual_clock_out?: string | null
          created_at?: string
          employee_id?: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          source?: string
          source_hash?: string
          source_updated_at?: string | null
          source_version?: number
          sync_run_id?: string | null
          synced_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_records_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_status_records: {
        Row: {
          attendance_status_id: string
          created_at: string
          created_by: string | null
          employee_id: string
          external_id: string | null
          id: string
          is_current: boolean
          reason: string | null
          source: string
          source_hash: string
          source_updated_at: string | null
          source_version: number
          sync_run_id: string | null
          synced_at: string
          work_date: string
        }
        Insert: {
          attendance_status_id: string
          created_at?: string
          created_by?: string | null
          employee_id: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          reason?: string | null
          source: string
          source_hash: string
          source_updated_at?: string | null
          source_version?: number
          sync_run_id?: string | null
          synced_at?: string
          work_date: string
        }
        Update: {
          attendance_status_id?: string
          created_at?: string
          created_by?: string | null
          employee_id?: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          reason?: string | null
          source?: string
          source_hash?: string
          source_updated_at?: string | null
          source_version?: number
          sync_run_id?: string | null
          synced_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_status_records_attendance_status_id_fkey"
            columns: ["attendance_status_id"]
            isOneToOne: false
            referencedRelation: "attendance_statuses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_status_records_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_status_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_status_records_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_statuses: {
        Row: {
          active: boolean
          category: string
          code: string
          created_at: string
          id: string
          name: string
          requires_review: boolean
        }
        Insert: {
          active?: boolean
          category: string
          code: string
          created_at?: string
          id?: string
          name: string
          requires_review?: boolean
        }
        Update: {
          active?: boolean
          category?: string
          code?: string
          created_at?: string
          id?: string
          name?: string
          requires_review?: boolean
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          entity_id: string
          entity_type: string
          id: string
          metadata: Json | null
          occurred_at: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          entity_id: string
          entity_type: string
          id?: string
          metadata?: Json | null
          occurred_at?: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          metadata?: Json | null
          occurred_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      authorized_email_roles: {
        Row: {
          created_at: string
          email: string
          platform_role: Database["public"]["Enums"]["platform_role"] | null
          role: Database["public"]["Enums"]["app_role"]
        }
        Insert: {
          created_at?: string
          email: string
          platform_role?: Database["public"]["Enums"]["platform_role"] | null
          role: Database["public"]["Enums"]["app_role"]
        }
        Update: {
          created_at?: string
          email?: string
          platform_role?: Database["public"]["Enums"]["platform_role"] | null
          role?: Database["public"]["Enums"]["app_role"]
        }
        Relationships: []
      }
      bonus_policies: {
        Row: {
          amount: number
          bonus_type_id: string
          created_at: string
          currency: string
          effective_from: string
          effective_to: string | null
          employee_group_id: string
          id: string
          threshold_minutes: number | null
          trigger_type: string
        }
        Insert: {
          amount: number
          bonus_type_id: string
          created_at?: string
          currency?: string
          effective_from: string
          effective_to?: string | null
          employee_group_id: string
          id?: string
          threshold_minutes?: number | null
          trigger_type: string
        }
        Update: {
          amount?: number
          bonus_type_id?: string
          created_at?: string
          currency?: string
          effective_from?: string
          effective_to?: string | null
          employee_group_id?: string
          id?: string
          threshold_minutes?: number | null
          trigger_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "bonus_policies_bonus_type_id_fkey"
            columns: ["bonus_type_id"]
            isOneToOne: false
            referencedRelation: "bonus_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bonus_policies_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      bonus_types: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      colaciones_discount_workbooks: {
        Row: {
          active: boolean
          checksum: string
          created_at: string
          file_size: number
          id: string
          original_filename: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          active?: boolean
          checksum: string
          created_at?: string
          file_size: number
          id?: string
          original_filename: string
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          active?: boolean
          checksum?: string
          created_at?: string
          file_size?: number
          id?: string
          original_filename?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "colaciones_discount_workbooks_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          active: boolean
          country_code: string
          created_at: string
          created_by: string | null
          id: string
          legal_name: string | null
          name: string
          onboarded_at: string | null
          plan_code: string
          primary_contact_email: string | null
          primary_contact_name: string | null
          slug: string
          status: Database["public"]["Enums"]["company_lifecycle_status"]
          timezone: string
          updated_at: string
          workspace_enabled: boolean
        }
        Insert: {
          active?: boolean
          country_code?: string
          created_at?: string
          created_by?: string | null
          id?: string
          legal_name?: string | null
          name: string
          onboarded_at?: string | null
          plan_code?: string
          primary_contact_email?: string | null
          primary_contact_name?: string | null
          slug: string
          status?: Database["public"]["Enums"]["company_lifecycle_status"]
          timezone?: string
          updated_at?: string
          workspace_enabled?: boolean
        }
        Update: {
          active?: boolean
          country_code?: string
          created_at?: string
          created_by?: string | null
          id?: string
          legal_name?: string | null
          name?: string
          onboarded_at?: string | null
          plan_code?: string
          primary_contact_email?: string | null
          primary_contact_name?: string | null
          slug?: string
          status?: Database["public"]["Enums"]["company_lifecycle_status"]
          timezone?: string
          updated_at?: string
          workspace_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "companies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      company_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          company_id: string
          created_at: string
          delivery_attempts: number
          delivery_error_code: string | null
          delivery_status: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          last_delivery_at: string | null
          role_id: string
          status: Database["public"]["Enums"]["company_invitation_status"]
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          company_id: string
          created_at?: string
          delivery_attempts?: number
          delivery_error_code?: string | null
          delivery_status?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          last_delivery_at?: string | null
          role_id: string
          status?: Database["public"]["Enums"]["company_invitation_status"]
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          company_id?: string
          created_at?: string
          delivery_attempts?: number
          delivery_error_code?: string | null
          delivery_status?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          last_delivery_at?: string | null
          role_id?: string
          status?: Database["public"]["Enums"]["company_invitation_status"]
        }
        Relationships: [
          {
            foreignKeyName: "company_invitations_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_invitations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_invitations_company_id_role_id_fkey"
            columns: ["company_id", "role_id"]
            isOneToOne: false
            referencedRelation: "company_roles"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "company_invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      company_membership_roles: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          company_id: string
          membership_id: string
          role_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          company_id: string
          membership_id: string
          role_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          company_id?: string
          membership_id?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_membership_roles_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_membership_roles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_membership_roles_company_id_membership_id_fkey"
            columns: ["company_id", "membership_id"]
            isOneToOne: false
            referencedRelation: "company_memberships"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "company_membership_roles_company_id_role_id_fkey"
            columns: ["company_id", "role_id"]
            isOneToOne: false
            referencedRelation: "company_roles"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      company_memberships: {
        Row: {
          active: boolean
          company_id: string
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          company_id: string
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          company_id?: string
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_memberships_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      company_modules: {
        Row: {
          company_id: string
          enabled_at: string | null
          enabled_by: string | null
          module_key: string
          settings: Json
          settings_version: number
          status: Database["public"]["Enums"]["company_module_status"]
          updated_at: string
        }
        Insert: {
          company_id: string
          enabled_at?: string | null
          enabled_by?: string | null
          module_key: string
          settings?: Json
          settings_version?: number
          status?: Database["public"]["Enums"]["company_module_status"]
          updated_at?: string
        }
        Update: {
          company_id?: string
          enabled_at?: string | null
          enabled_by?: string | null
          module_key?: string
          settings?: Json
          settings_version?: number
          status?: Database["public"]["Enums"]["company_module_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_modules_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_modules_enabled_by_fkey"
            columns: ["enabled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_modules_module_key_fkey"
            columns: ["module_key"]
            isOneToOne: false
            referencedRelation: "module_catalog"
            referencedColumns: ["key"]
          },
        ]
      }
      company_onboarding_steps: {
        Row: {
          company_id: string
          completed_at: string | null
          completed_by: string | null
          notes: string | null
          status: Database["public"]["Enums"]["company_onboarding_status"]
          step_key: string
          updated_at: string
        }
        Insert: {
          company_id: string
          completed_at?: string | null
          completed_by?: string | null
          notes?: string | null
          status?: Database["public"]["Enums"]["company_onboarding_status"]
          step_key: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          completed_at?: string | null
          completed_by?: string | null
          notes?: string | null
          status?: Database["public"]["Enums"]["company_onboarding_status"]
          step_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_onboarding_steps_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_onboarding_steps_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_onboarding_steps_step_key_fkey"
            columns: ["step_key"]
            isOneToOne: false
            referencedRelation: "onboarding_step_catalog"
            referencedColumns: ["key"]
          },
        ]
      }
      company_role_permissions: {
        Row: {
          company_id: string
          created_at: string
          permission_code: string
          role_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          permission_code: string
          role_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          permission_code?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_role_permissions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_role_permissions_company_id_role_id_fkey"
            columns: ["company_id", "role_id"]
            isOneToOne: false
            referencedRelation: "company_roles"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "company_role_permissions_permission_code_fkey"
            columns: ["permission_code"]
            isOneToOne: false
            referencedRelation: "permission_definitions"
            referencedColumns: ["code"]
          },
        ]
      }
      company_roles: {
        Row: {
          active: boolean
          base_role: Database["public"]["Enums"]["app_role"] | null
          code: string
          company_id: string
          created_at: string
          description: string | null
          id: string
          is_system: boolean
          name: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          base_role?: Database["public"]["Enums"]["app_role"] | null
          code: string
          company_id: string
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          base_role?: Database["public"]["Enums"]["app_role"] | null
          code?: string
          company_id?: string
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_roles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_reviews: {
        Row: {
          created_at: string
          employee_id: string
          id: string
          status: Database["public"]["Enums"]["daily_review_status"]
          updated_at: string
          weekly_review_id: string | null
          work_date: string
        }
        Insert: {
          created_at?: string
          employee_id: string
          id?: string
          status?: Database["public"]["Enums"]["daily_review_status"]
          updated_at?: string
          weekly_review_id?: string | null
          work_date: string
        }
        Update: {
          created_at?: string
          employee_id?: string
          id?: string
          status?: Database["public"]["Enums"]["daily_review_status"]
          updated_at?: string
          weekly_review_id?: string | null
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_reviews_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_reviews_weekly_review_id_fkey"
            columns: ["weekly_review_id"]
            isOneToOne: false
            referencedRelation: "weekly_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      early_departure_decisions: {
        Row: {
          created_at: string
          decided_at: string
          decided_by: string
          document_deadline: string | null
          document_required: boolean
          early_departure_record_id: string
          id: string
          is_current: boolean
          payroll_effect: string
          payroll_minutes: number
          reason: string | null
          reason_category: string
        }
        Insert: {
          created_at?: string
          decided_at?: string
          decided_by?: string
          document_deadline?: string | null
          document_required?: boolean
          early_departure_record_id: string
          id?: string
          is_current?: boolean
          payroll_effect: string
          payroll_minutes: number
          reason?: string | null
          reason_category: string
        }
        Update: {
          created_at?: string
          decided_at?: string
          decided_by?: string
          document_deadline?: string | null
          document_required?: boolean
          early_departure_record_id?: string
          id?: string
          is_current?: boolean
          payroll_effect?: string
          payroll_minutes?: number
          reason?: string | null
          reason_category?: string
        }
        Relationships: [
          {
            foreignKeyName: "early_departure_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "early_departure_decisions_early_departure_record_id_fkey"
            columns: ["early_departure_record_id"]
            isOneToOne: false
            referencedRelation: "early_departure_records"
            referencedColumns: ["id"]
          },
        ]
      }
      early_departure_records: {
        Row: {
          actual_end: string
          attendance_record_id: string
          calculated_at: string
          calculation_version: number
          created_at: string
          detected_minutes: number
          employee_id: string
          id: string
          is_current: boolean
          scheduled_end: string
          work_date: string
        }
        Insert: {
          actual_end: string
          attendance_record_id: string
          calculated_at?: string
          calculation_version?: number
          created_at?: string
          detected_minutes: number
          employee_id: string
          id?: string
          is_current?: boolean
          scheduled_end: string
          work_date: string
        }
        Update: {
          actual_end?: string
          attendance_record_id?: string
          calculated_at?: string
          calculation_version?: number
          created_at?: string
          detected_minutes?: number
          employee_id?: string
          id?: string
          is_current?: boolean
          scheduled_end?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "early_departure_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_effective_punches"
            referencedColumns: ["attendance_record_id"]
          },
          {
            foreignKeyName: "early_departure_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "early_departure_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_birthdays: {
        Row: {
          birth_day: number
          birth_month: number
          created_at: string
          created_by: string | null
          employee_id: string
          id: string
          imported_at: string
        }
        Insert: {
          birth_day: number
          birth_month: number
          created_at?: string
          created_by?: string | null
          employee_id: string
          id?: string
          imported_at?: string
        }
        Update: {
          birth_day?: number
          birth_month?: number
          created_at?: string
          created_by?: string | null
          employee_id?: string
          id?: string
          imported_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_birthdays_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_birthdays_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: true
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_daily_bonuses: {
        Row: {
          amount: number
          bonus_policy_id: string
          created_at: string
          currency: string
          employee_id: string
          granted_at: string
          id: string
          overtime_decision_id: string
          work_date: string
        }
        Insert: {
          amount: number
          bonus_policy_id: string
          created_at?: string
          currency?: string
          employee_id: string
          granted_at?: string
          id?: string
          overtime_decision_id: string
          work_date: string
        }
        Update: {
          amount?: number
          bonus_policy_id?: string
          created_at?: string
          currency?: string
          employee_id?: string
          granted_at?: string
          id?: string
          overtime_decision_id?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_daily_bonuses_bonus_policy_id_fkey"
            columns: ["bonus_policy_id"]
            isOneToOne: false
            referencedRelation: "bonus_policies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_daily_bonuses_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_daily_bonuses_overtime_decision_id_fkey"
            columns: ["overtime_decision_id"]
            isOneToOne: true
            referencedRelation: "overtime_decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_group_assignments: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          employee_group_id: string
          employee_id: string
          id: string
          source: string
          sync_run_id: string | null
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          employee_group_id: string
          employee_id: string
          id?: string
          source?: string
          sync_run_id?: string | null
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          employee_group_id?: string
          employee_id?: string
          id?: string
          source?: string
          sync_run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_group_assignments_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_group_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_group_assignments_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_groups: {
        Row: {
          active: boolean
          code: string
          company_id: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          code: string
          company_id?: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          code?: string
          company_id?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_groups_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_org_assignments: {
        Row: {
          company_id: string
          created_at: string
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          is_primary: boolean
          org_unit_id: string
          position_id: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          effective_from: string
          effective_to?: string | null
          employee_id: string
          id?: string
          is_primary?: boolean
          org_unit_id: string
          position_id?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          is_primary?: boolean
          org_unit_id?: string
          position_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_org_assignments_company_id_employee_id_fkey"
            columns: ["company_id", "employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "employee_org_assignments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_org_assignments_company_id_org_unit_id_fkey"
            columns: ["company_id", "org_unit_id"]
            isOneToOne: false
            referencedRelation: "organization_units"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "employee_org_assignments_company_id_position_id_fkey"
            columns: ["company_id", "position_id"]
            isOneToOne: false
            referencedRelation: "job_positions"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      employee_time_control_policies: {
        Row: {
          created_at: string
          created_by: string
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          legal_basis: string | null
          policy_code: string
          reason: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          effective_from: string
          effective_to?: string | null
          employee_id: string
          id?: string
          legal_basis?: string | null
          policy_code: string
          reason?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          legal_basis?: string | null
          policy_code?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_time_control_policies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_time_control_policies_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          active: boolean
          company_id: string
          created_at: string
          display_name: string
          employee_group_id: string | null
          external_workera_id: string
          first_name: string
          hire_date: string | null
          id: string
          last_name: string
          rut: string | null
          source: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          company_id?: string
          created_at?: string
          display_name: string
          employee_group_id?: string | null
          external_workera_id: string
          first_name: string
          hire_date?: string | null
          id?: string
          last_name: string
          rut?: string | null
          source?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          company_id?: string
          created_at?: string
          display_name?: string
          employee_group_id?: string | null
          external_workera_id?: string
          first_name?: string
          hire_date?: string | null
          id?: string
          last_name?: string
          rut?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employees_company_group_fkey"
            columns: ["company_id", "employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "employees_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      excel_exports: {
        Row: {
          created_at: string
          export_scope: string
          file_hash: string | null
          generated_at: string
          generated_by: string
          id: string
          period_snapshot_id: string | null
          reporting_period_id: string | null
          snapshot_id: string | null
          storage_path: string | null
          template_version: string
          validation_status: string
          weekly_review_id: string | null
        }
        Insert: {
          created_at?: string
          export_scope?: string
          file_hash?: string | null
          generated_at?: string
          generated_by?: string
          id?: string
          period_snapshot_id?: string | null
          reporting_period_id?: string | null
          snapshot_id?: string | null
          storage_path?: string | null
          template_version: string
          validation_status: string
          weekly_review_id?: string | null
        }
        Update: {
          created_at?: string
          export_scope?: string
          file_hash?: string | null
          generated_at?: string
          generated_by?: string
          id?: string
          period_snapshot_id?: string | null
          reporting_period_id?: string | null
          snapshot_id?: string | null
          storage_path?: string | null
          template_version?: string
          validation_status?: string
          weekly_review_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "excel_exports_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excel_exports_period_snapshot_id_fkey"
            columns: ["period_snapshot_id"]
            isOneToOne: false
            referencedRelation: "period_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excel_exports_reporting_period_id_fkey"
            columns: ["reporting_period_id"]
            isOneToOne: false
            referencedRelation: "reporting_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excel_exports_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "weekly_review_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excel_exports_weekly_review_id_fkey"
            columns: ["weekly_review_id"]
            isOneToOne: false
            referencedRelation: "weekly_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_accounting_export_events: {
        Row: {
          actor_id: string | null
          company_id: string
          event_type: string
          export_id: string
          id: number
          metadata: Json
          occurred_at: string
        }
        Insert: {
          actor_id?: string | null
          company_id: string
          event_type: string
          export_id: string
          id?: never
          metadata?: Json
          occurred_at?: string
        }
        Update: {
          actor_id?: string | null
          company_id?: string
          event_type?: string
          export_id?: string
          id?: never
          metadata?: Json
          occurred_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_accounting_export_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_accounting_export_events_company_id_export_id_fkey"
            columns: ["company_id", "export_id"]
            isOneToOne: false
            referencedRelation: "expense_accounting_exports"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "expense_accounting_export_events_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_accounting_exports: {
        Row: {
          attempt_count: number
          available_at: string
          company_id: string
          exported_at: string | null
          external_reference: string | null
          id: string
          idempotency_key: string
          last_error_code: string | null
          last_error_summary: string | null
          lease_expires_at: string | null
          lease_token: string | null
          max_attempts: number
          payload: Json
          payload_sha256: string
          provider_code: string
          report_id: string
          requested_at: string
          requested_by: string
          status: Database["public"]["Enums"]["expense_accounting_export_status"]
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          available_at?: string
          company_id: string
          exported_at?: string | null
          external_reference?: string | null
          id?: string
          idempotency_key: string
          last_error_code?: string | null
          last_error_summary?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          max_attempts?: number
          payload: Json
          payload_sha256: string
          provider_code?: string
          report_id: string
          requested_at?: string
          requested_by: string
          status?: Database["public"]["Enums"]["expense_accounting_export_status"]
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          available_at?: string
          company_id?: string
          exported_at?: string | null
          external_reference?: string | null
          id?: string
          idempotency_key?: string
          last_error_code?: string | null
          last_error_summary?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          max_attempts?: number
          payload?: Json
          payload_sha256?: string
          provider_code?: string
          report_id?: string
          requested_at?: string
          requested_by?: string
          status?: Database["public"]["Enums"]["expense_accounting_export_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_accounting_exports_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_accounting_exports_company_id_report_id_fkey"
            columns: ["company_id", "report_id"]
            isOneToOne: false
            referencedRelation: "expense_reports"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "expense_accounting_exports_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_advances: {
        Row: {
          amount: number
          cancelled_at: string | null
          cancelled_by: string | null
          company_id: string
          created_at: string
          currency_code: string
          granted_at: string
          granted_by: string
          id: string
          purpose: string
          recipient_id: string
          settled_at: string | null
          settled_by: string | null
          status: Database["public"]["Enums"]["expense_advance_status"]
        }
        Insert: {
          amount: number
          cancelled_at?: string | null
          cancelled_by?: string | null
          company_id: string
          created_at?: string
          currency_code?: string
          granted_at?: string
          granted_by: string
          id?: string
          purpose: string
          recipient_id: string
          settled_at?: string | null
          settled_by?: string | null
          status?: Database["public"]["Enums"]["expense_advance_status"]
        }
        Update: {
          amount?: number
          cancelled_at?: string | null
          cancelled_by?: string | null
          company_id?: string
          created_at?: string
          currency_code?: string
          granted_at?: string
          granted_by?: string
          id?: string
          purpose?: string
          recipient_id?: string
          settled_at?: string | null
          settled_by?: string | null
          status?: Database["public"]["Enums"]["expense_advance_status"]
        }
        Relationships: [
          {
            foreignKeyName: "expense_advances_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_advances_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_advances_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_advances_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_advances_settled_by_fkey"
            columns: ["settled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_approval_decisions: {
        Row: {
          comment: string | null
          company_id: string
          decided_at: string
          decided_by: string
          decision: Database["public"]["Enums"]["expense_approval_decision"]
          id: string
          report_id: string
          review_round: number
          step_number: number
        }
        Insert: {
          comment?: string | null
          company_id: string
          decided_at?: string
          decided_by: string
          decision: Database["public"]["Enums"]["expense_approval_decision"]
          id?: string
          report_id: string
          review_round: number
          step_number: number
        }
        Update: {
          comment?: string | null
          company_id?: string
          decided_at?: string
          decided_by?: string
          decision?: Database["public"]["Enums"]["expense_approval_decision"]
          id?: string
          report_id?: string
          review_round?: number
          step_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "expense_approval_decisions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_approval_decisions_company_id_report_id_fkey"
            columns: ["company_id", "report_id"]
            isOneToOne: false
            referencedRelation: "expense_reports"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "expense_approval_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_audit_events: {
        Row: {
          actor_id: string | null
          company_id: string
          event_type: string
          id: number
          metadata: Json
          occurred_at: string
          report_id: string | null
        }
        Insert: {
          actor_id?: string | null
          company_id: string
          event_type: string
          id?: never
          metadata?: Json
          occurred_at?: string
          report_id?: string | null
        }
        Update: {
          actor_id?: string | null
          company_id?: string
          event_type?: string
          id?: never
          metadata?: Json
          occurred_at?: string
          report_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expense_audit_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_audit_events_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_audit_events_company_id_report_id_fkey"
            columns: ["company_id", "report_id"]
            isOneToOne: false
            referencedRelation: "expense_reports"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      expense_bank_import_usage_windows: {
        Row: {
          attempt_count: number
          company_id: string
          payload_bytes: number
          scope_key: string
          updated_at: string
          window_started_at: string
        }
        Insert: {
          attempt_count: number
          company_id: string
          payload_bytes: number
          scope_key: string
          updated_at?: string
          window_started_at: string
        }
        Update: {
          attempt_count?: number
          company_id?: string
          payload_bytes?: number
          scope_key?: string
          updated_at?: string
          window_started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_bank_import_usage_windows_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_bank_imports: {
        Row: {
          company_id: string
          content_checksum_sha256: string
          id: string
          imported_at: string
          row_count: number
          source_channel: string
          uploaded_by: string
        }
        Insert: {
          company_id: string
          content_checksum_sha256: string
          id?: string
          imported_at?: string
          row_count: number
          source_channel: string
          uploaded_by: string
        }
        Update: {
          company_id?: string
          content_checksum_sha256?: string
          id?: string
          imported_at?: string
          row_count?: number
          source_channel?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_bank_imports_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_bank_imports_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_bank_transactions: {
        Row: {
          amount: number
          bank_reference: string
          company_id: string
          created_at: string
          currency_code: string
          description: string | null
          id: string
          ignored_reason: string | null
          import_id: string
          match_fingerprint: string
          match_method: string | null
          matched_at: string | null
          matched_by: string | null
          matched_report_id: string | null
          source_row_number: number
          status: Database["public"]["Enums"]["expense_bank_transaction_status"]
          transaction_date: string
        }
        Insert: {
          amount: number
          bank_reference: string
          company_id: string
          created_at?: string
          currency_code: string
          description?: string | null
          id?: string
          ignored_reason?: string | null
          import_id: string
          match_fingerprint: string
          match_method?: string | null
          matched_at?: string | null
          matched_by?: string | null
          matched_report_id?: string | null
          source_row_number: number
          status?: Database["public"]["Enums"]["expense_bank_transaction_status"]
          transaction_date: string
        }
        Update: {
          amount?: number
          bank_reference?: string
          company_id?: string
          created_at?: string
          currency_code?: string
          description?: string | null
          id?: string
          ignored_reason?: string | null
          import_id?: string
          match_fingerprint?: string
          match_method?: string | null
          matched_at?: string | null
          matched_by?: string | null
          matched_report_id?: string | null
          source_row_number?: number
          status?: Database["public"]["Enums"]["expense_bank_transaction_status"]
          transaction_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_bank_transactions_import_fk"
            columns: ["company_id", "import_id"]
            isOneToOne: false
            referencedRelation: "expense_bank_imports"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "expense_bank_transactions_matched_by_fkey"
            columns: ["matched_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_bank_transactions_report_fk"
            columns: ["company_id", "matched_report_id"]
            isOneToOne: false
            referencedRelation: "expense_reports"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      expense_categories: {
        Row: {
          active: boolean
          code: string
          company_id: string
          created_at: string
          id: string
          name: string
          requires_receipt: boolean
          updated_at: string
        }
        Insert: {
          active?: boolean
          code: string
          company_id: string
          created_at?: string
          id?: string
          name: string
          requires_receipt?: boolean
          updated_at?: string
        }
        Update: {
          active?: boolean
          code?: string
          company_id?: string
          created_at?: string
          id?: string
          name?: string
          requires_receipt?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_categories_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_items: {
        Row: {
          category_id: string | null
          company_id: string
          created_at: string
          currency_code: string
          description: string
          distance_km: number | null
          duplicate_fingerprint: string | null
          expense_date: string
          extraction: Json
          id: string
          merchant_name: string | null
          net_amount: number
          per_diem_days: number | null
          receipt_status: Database["public"]["Enums"]["expense_receipt_status"]
          receipt_storage_path: string | null
          report_id: string
          tax_amount: number
          total_amount: number | null
          updated_at: string
        }
        Insert: {
          category_id?: string | null
          company_id: string
          created_at?: string
          currency_code?: string
          description: string
          distance_km?: number | null
          duplicate_fingerprint?: string | null
          expense_date: string
          extraction?: Json
          id?: string
          merchant_name?: string | null
          net_amount?: number
          per_diem_days?: number | null
          receipt_status?: Database["public"]["Enums"]["expense_receipt_status"]
          receipt_storage_path?: string | null
          report_id: string
          tax_amount?: number
          total_amount?: number | null
          updated_at?: string
        }
        Update: {
          category_id?: string | null
          company_id?: string
          created_at?: string
          currency_code?: string
          description?: string
          distance_km?: number | null
          duplicate_fingerprint?: string | null
          expense_date?: string
          extraction?: Json
          id?: string
          merchant_name?: string | null
          net_amount?: number
          per_diem_days?: number | null
          receipt_status?: Database["public"]["Enums"]["expense_receipt_status"]
          receipt_storage_path?: string | null
          report_id?: string
          tax_amount?: number
          total_amount?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_items_company_id_category_id_fkey"
            columns: ["company_id", "category_id"]
            isOneToOne: false
            referencedRelation: "expense_categories"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "expense_items_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_items_company_id_report_id_fkey"
            columns: ["company_id", "report_id"]
            isOneToOne: false
            referencedRelation: "expense_reports"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      expense_ocr_jobs: {
        Row: {
          attempt: number
          available_at: string
          company_id: string
          created_at: string
          error_category: string | null
          error_summary: string | null
          finished_at: string | null
          id: string
          locked_at: string | null
          locked_by: string | null
          provider: string
          provider_operation_url: string | null
          receipt_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["expense_ocr_job_status"]
        }
        Insert: {
          attempt: number
          available_at?: string
          company_id: string
          created_at?: string
          error_category?: string | null
          error_summary?: string | null
          finished_at?: string | null
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          provider?: string
          provider_operation_url?: string | null
          receipt_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["expense_ocr_job_status"]
        }
        Update: {
          attempt?: number
          available_at?: string
          company_id?: string
          created_at?: string
          error_category?: string | null
          error_summary?: string | null
          finished_at?: string | null
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          provider?: string
          provider_operation_url?: string | null
          receipt_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["expense_ocr_job_status"]
        }
        Relationships: [
          {
            foreignKeyName: "expense_ocr_jobs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_ocr_jobs_company_id_receipt_id_fkey"
            columns: ["company_id", "receipt_id"]
            isOneToOne: false
            referencedRelation: "expense_receipts"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      expense_ocr_reviews: {
        Row: {
          comment: string | null
          company_id: string
          decision: Database["public"]["Enums"]["expense_ocr_review_decision"]
          id: string
          receipt_id: string
          reviewed_at: string
          reviewed_by: string
        }
        Insert: {
          comment?: string | null
          company_id: string
          decision: Database["public"]["Enums"]["expense_ocr_review_decision"]
          id?: string
          receipt_id: string
          reviewed_at?: string
          reviewed_by: string
        }
        Update: {
          comment?: string | null
          company_id?: string
          decision?: Database["public"]["Enums"]["expense_ocr_review_decision"]
          id?: string
          receipt_id?: string
          reviewed_at?: string
          reviewed_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_ocr_reviews_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_ocr_reviews_company_id_receipt_id_fkey"
            columns: ["company_id", "receipt_id"]
            isOneToOne: false
            referencedRelation: "expense_receipts"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "expense_ocr_reviews_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_policies: {
        Row: {
          active: boolean
          company_id: string
          created_at: string
          created_by: string
          currency_code: string
          id: string
          name: string
          rules: Json
          updated_at: string
          version: number
        }
        Insert: {
          active?: boolean
          company_id: string
          created_at?: string
          created_by: string
          currency_code?: string
          id?: string
          name: string
          rules?: Json
          updated_at?: string
          version?: number
        }
        Update: {
          active?: boolean
          company_id?: string
          created_at?: string
          created_by?: string
          currency_code?: string
          id?: string
          name?: string
          rules?: Json
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "expense_policies_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_policies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_receipt_captures: {
        Row: {
          attached_at: string | null
          attached_receipt_id: string | null
          checksum_sha256: string
          company_id: string
          created_at: string
          discarded_at: string | null
          external_message_id: string | null
          file_size: number
          id: string
          mime_type: string
          original_filename: string
          source: string
          status: string
          storage_path: string
          updated_at: string
          uploaded_by: string
        }
        Insert: {
          attached_at?: string | null
          attached_receipt_id?: string | null
          checksum_sha256: string
          company_id: string
          created_at?: string
          discarded_at?: string | null
          external_message_id?: string | null
          file_size: number
          id?: string
          mime_type: string
          original_filename: string
          source: string
          status?: string
          storage_path: string
          updated_at?: string
          uploaded_by: string
        }
        Update: {
          attached_at?: string | null
          attached_receipt_id?: string | null
          checksum_sha256?: string
          company_id?: string
          created_at?: string
          discarded_at?: string | null
          external_message_id?: string | null
          file_size?: number
          id?: string
          mime_type?: string
          original_filename?: string
          source?: string
          status?: string
          storage_path?: string
          updated_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_receipt_captures_company_id_attached_receipt_id_fkey"
            columns: ["company_id", "attached_receipt_id"]
            isOneToOne: false
            referencedRelation: "expense_receipts"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "expense_receipt_captures_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_receipt_captures_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_receipt_email_aliases: {
        Row: {
          active: boolean
          alias_token: string
          company_id: string
          created_at: string
          id: string
          rotated_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          alias_token?: string
          company_id: string
          created_at?: string
          id?: string
          rotated_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          alias_token?: string
          company_id?: string
          created_at?: string
          id?: string
          rotated_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_receipt_email_aliases_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_receipt_email_aliases_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: true
            referencedRelation: "company_memberships"
            referencedColumns: ["company_id", "user_id"]
          },
          {
            foreignKeyName: "expense_receipt_email_aliases_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_receipt_email_events: {
        Row: {
          attempt_count: number
          claim_token: string | null
          company_id: string
          completed_at: string | null
          consumed_slots: number
          created_at: string
          lease_expires_at: string | null
          provider_email_id: string
          provider_event_id: string
          reserved_bytes: number
          reserved_slots: number
          status: string
          updated_at: string
          usage_window_started_at: string
          user_id: string
        }
        Insert: {
          attempt_count?: number
          claim_token?: string | null
          company_id: string
          completed_at?: string | null
          consumed_slots?: number
          created_at?: string
          lease_expires_at?: string | null
          provider_email_id: string
          provider_event_id: string
          reserved_bytes?: number
          reserved_slots: number
          status: string
          updated_at?: string
          usage_window_started_at: string
          user_id: string
        }
        Update: {
          attempt_count?: number
          claim_token?: string | null
          company_id?: string
          completed_at?: string | null
          consumed_slots?: number
          created_at?: string
          lease_expires_at?: string | null
          provider_email_id?: string
          provider_event_id?: string
          reserved_bytes?: number
          reserved_slots?: number
          status?: string
          updated_at?: string
          usage_window_started_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_receipt_email_events_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_receipt_email_events_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: false
            referencedRelation: "company_memberships"
            referencedColumns: ["company_id", "user_id"]
          },
          {
            foreignKeyName: "expense_receipt_email_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_receipt_email_usage_windows: {
        Row: {
          company_id: string
          event_count: number
          rejected_count: number
          reserved_bytes: number
          reserved_slots: number
          updated_at: string
          user_id: string
          window_started_at: string
        }
        Insert: {
          company_id: string
          event_count?: number
          rejected_count?: number
          reserved_bytes?: number
          reserved_slots?: number
          updated_at?: string
          user_id: string
          window_started_at: string
        }
        Update: {
          company_id?: string
          event_count?: number
          rejected_count?: number
          reserved_bytes?: number
          reserved_slots?: number
          updated_at?: string
          user_id?: string
          window_started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_receipt_email_usage_windows_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_receipt_email_usage_windows_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: false
            referencedRelation: "company_memberships"
            referencedColumns: ["company_id", "user_id"]
          },
          {
            foreignKeyName: "expense_receipt_email_usage_windows_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_receipt_whatsapp_events: {
        Row: {
          attempt_count: number
          claim_token: string | null
          company_id: string
          completed_at: string | null
          created_at: string
          lease_expires_at: string | null
          provider_message_hash: string
          reserved_bytes: number
          status: string
          updated_at: string
          usage_window_started_at: string
          user_id: string
        }
        Insert: {
          attempt_count?: number
          claim_token?: string | null
          company_id: string
          completed_at?: string | null
          created_at?: string
          lease_expires_at?: string | null
          provider_message_hash: string
          reserved_bytes?: number
          status: string
          updated_at?: string
          usage_window_started_at: string
          user_id: string
        }
        Update: {
          attempt_count?: number
          claim_token?: string | null
          company_id?: string
          completed_at?: string | null
          created_at?: string
          lease_expires_at?: string | null
          provider_message_hash?: string
          reserved_bytes?: number
          status?: string
          updated_at?: string
          usage_window_started_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_receipt_whatsapp_events_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_receipt_whatsapp_events_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: false
            referencedRelation: "company_memberships"
            referencedColumns: ["company_id", "user_id"]
          },
          {
            foreignKeyName: "expense_receipt_whatsapp_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_receipt_whatsapp_links: {
        Row: {
          active: boolean
          company_id: string
          created_at: string
          paired_at: string | null
          pairing_expires_at: string | null
          pairing_token_hash: string | null
          updated_at: string
          user_id: string
          wa_id_hash: string | null
        }
        Insert: {
          active?: boolean
          company_id: string
          created_at?: string
          paired_at?: string | null
          pairing_expires_at?: string | null
          pairing_token_hash?: string | null
          updated_at?: string
          user_id: string
          wa_id_hash?: string | null
        }
        Update: {
          active?: boolean
          company_id?: string
          created_at?: string
          paired_at?: string | null
          pairing_expires_at?: string | null
          pairing_token_hash?: string | null
          updated_at?: string
          user_id?: string
          wa_id_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expense_receipt_whatsapp_links_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_receipt_whatsapp_links_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: true
            referencedRelation: "company_memberships"
            referencedColumns: ["company_id", "user_id"]
          },
          {
            foreignKeyName: "expense_receipt_whatsapp_links_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_receipt_whatsapp_usage_windows: {
        Row: {
          company_id: string
          event_count: number
          reserved_bytes: number
          updated_at: string
          user_id: string
          window_started_at: string
        }
        Insert: {
          company_id: string
          event_count?: number
          reserved_bytes?: number
          updated_at?: string
          user_id: string
          window_started_at: string
        }
        Update: {
          company_id?: string
          event_count?: number
          reserved_bytes?: number
          updated_at?: string
          user_id?: string
          window_started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_receipt_whatsapp_usage_windows_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_receipt_whatsapp_usage_windows_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: false
            referencedRelation: "company_memberships"
            referencedColumns: ["company_id", "user_id"]
          },
          {
            foreignKeyName: "expense_receipt_whatsapp_usage_windows_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_receipts: {
        Row: {
          checksum_sha256: string
          company_id: string
          created_at: string
          duplicate_of_receipt_id: string | null
          extraction: Json
          file_size: number
          id: string
          is_current: boolean
          item_id: string
          mime_type: string
          original_filename: string
          report_id: string
          status: Database["public"]["Enums"]["expense_receipt_status"]
          storage_path: string
          uploaded_by: string
          version: number
        }
        Insert: {
          checksum_sha256: string
          company_id: string
          created_at?: string
          duplicate_of_receipt_id?: string | null
          extraction?: Json
          file_size: number
          id?: string
          is_current?: boolean
          item_id: string
          mime_type: string
          original_filename: string
          report_id: string
          status?: Database["public"]["Enums"]["expense_receipt_status"]
          storage_path: string
          uploaded_by: string
          version: number
        }
        Update: {
          checksum_sha256?: string
          company_id?: string
          created_at?: string
          duplicate_of_receipt_id?: string | null
          extraction?: Json
          file_size?: number
          id?: string
          is_current?: boolean
          item_id?: string
          mime_type?: string
          original_filename?: string
          report_id?: string
          status?: Database["public"]["Enums"]["expense_receipt_status"]
          storage_path?: string
          uploaded_by?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "expense_receipts_company_id_duplicate_of_receipt_id_fkey"
            columns: ["company_id", "duplicate_of_receipt_id"]
            isOneToOne: false
            referencedRelation: "expense_receipts"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "expense_receipts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_receipts_company_id_report_id_item_id_fkey"
            columns: ["company_id", "report_id", "item_id"]
            isOneToOne: false
            referencedRelation: "expense_items"
            referencedColumns: ["company_id", "report_id", "id"]
          },
          {
            foreignKeyName: "expense_receipts_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_reconciliation_events: {
        Row: {
          actor_id: string
          company_id: string
          event_type: string
          id: number
          metadata: Json
          occurred_at: string
          report_id: string | null
          transaction_id: string
        }
        Insert: {
          actor_id: string
          company_id: string
          event_type: string
          id?: never
          metadata?: Json
          occurred_at?: string
          report_id?: string | null
          transaction_id: string
        }
        Update: {
          actor_id?: string
          company_id?: string
          event_type?: string
          id?: never
          metadata?: Json
          occurred_at?: string
          report_id?: string | null
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_reconciliation_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_reconciliation_events_report_fk"
            columns: ["company_id", "report_id"]
            isOneToOne: false
            referencedRelation: "expense_reports"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "expense_reconciliation_events_transaction_fk"
            columns: ["company_id", "transaction_id"]
            isOneToOne: false
            referencedRelation: "expense_bank_transactions"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      expense_report_sequences: {
        Row: {
          company_id: string
          next_value: number
        }
        Insert: {
          company_id: string
          next_value?: number
        }
        Update: {
          company_id?: string
          next_value?: number
        }
        Relationships: [
          {
            foreignKeyName: "expense_report_sequences_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_reports: {
        Row: {
          advance_id: string | null
          client_request_id: string | null
          company_id: string
          created_at: string
          currency_code: string
          id: string
          organization_unit_id: string | null
          paid_at: string | null
          paid_by: string | null
          payment_reference: string | null
          policy_id: string | null
          purpose: string | null
          reference_number: string
          required_approval_steps: number
          resolved_at: string | null
          review_round: number
          status: Database["public"]["Enums"]["expense_report_status"]
          submitted_at: string | null
          submitted_by: string
          title: string
          total_amount: number
          updated_at: string
        }
        Insert: {
          advance_id?: string | null
          client_request_id?: string | null
          company_id: string
          created_at?: string
          currency_code?: string
          id?: string
          organization_unit_id?: string | null
          paid_at?: string | null
          paid_by?: string | null
          payment_reference?: string | null
          policy_id?: string | null
          purpose?: string | null
          reference_number?: string
          required_approval_steps?: number
          resolved_at?: string | null
          review_round?: number
          status?: Database["public"]["Enums"]["expense_report_status"]
          submitted_at?: string | null
          submitted_by: string
          title: string
          total_amount?: number
          updated_at?: string
        }
        Update: {
          advance_id?: string | null
          client_request_id?: string | null
          company_id?: string
          created_at?: string
          currency_code?: string
          id?: string
          organization_unit_id?: string | null
          paid_at?: string | null
          paid_by?: string | null
          payment_reference?: string | null
          policy_id?: string | null
          purpose?: string | null
          reference_number?: string
          required_approval_steps?: number
          resolved_at?: string | null
          review_round?: number
          status?: Database["public"]["Enums"]["expense_report_status"]
          submitted_at?: string | null
          submitted_by?: string
          title?: string
          total_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_reports_advance_company_fk"
            columns: ["company_id", "advance_id"]
            isOneToOne: false
            referencedRelation: "expense_advances"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "expense_reports_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_reports_company_id_organization_unit_id_fkey"
            columns: ["company_id", "organization_unit_id"]
            isOneToOne: false
            referencedRelation: "organization_units"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "expense_reports_company_id_policy_id_fkey"
            columns: ["company_id", "policy_id"]
            isOneToOne: false
            referencedRelation: "expense_policies"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "expense_reports_paid_by_fkey"
            columns: ["paid_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_reports_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      holidays: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          holiday_date: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          holiday_date: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          holiday_date?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "holidays_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_positions: {
        Row: {
          active: boolean
          code: string
          company_id: string
          created_at: string
          description: string | null
          id: string
          title: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          code: string
          company_id: string
          created_at?: string
          description?: string | null
          id?: string
          title: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          code?: string
          company_id?: string
          created_at?: string
          description?: string | null
          id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_positions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      late_arrival_decisions: {
        Row: {
          created_at: string
          decided_at: string
          decided_by: string
          id: string
          is_current: boolean
          justification_status: string | null
          justified: boolean
          late_arrival_record_id: string
          payroll_effect: string
          payroll_minutes: number
          reason: string | null
        }
        Insert: {
          created_at?: string
          decided_at?: string
          decided_by?: string
          id?: string
          is_current?: boolean
          justification_status?: string | null
          justified: boolean
          late_arrival_record_id: string
          payroll_effect: string
          payroll_minutes: number
          reason?: string | null
        }
        Update: {
          created_at?: string
          decided_at?: string
          decided_by?: string
          id?: string
          is_current?: boolean
          justification_status?: string | null
          justified?: boolean
          late_arrival_record_id?: string
          payroll_effect?: string
          payroll_minutes?: number
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "late_arrival_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "late_arrival_decisions_late_arrival_record_id_fkey"
            columns: ["late_arrival_record_id"]
            isOneToOne: false
            referencedRelation: "late_arrival_records"
            referencedColumns: ["id"]
          },
        ]
      }
      late_arrival_policies: {
        Row: {
          created_at: string
          day_of_week: number
          effective_from: string
          effective_to: string | null
          employee_group_id: string
          id: string
          tolerance_minutes: number
        }
        Insert: {
          created_at?: string
          day_of_week: number
          effective_from: string
          effective_to?: string | null
          employee_group_id: string
          id?: string
          tolerance_minutes?: number
        }
        Update: {
          created_at?: string
          day_of_week?: number
          effective_from?: string
          effective_to?: string | null
          employee_group_id?: string
          id?: string
          tolerance_minutes?: number
        }
        Relationships: [
          {
            foreignKeyName: "late_arrival_policies_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      late_arrival_records: {
        Row: {
          actual_start: string
          attendance_record_id: string
          calculated_at: string
          calculation_version: number
          created_at: string
          detected_minutes: number
          employee_id: string
          id: string
          is_current: boolean
          late_arrival_policy_id: string
          scheduled_start: string
          work_date: string
        }
        Insert: {
          actual_start: string
          attendance_record_id: string
          calculated_at?: string
          calculation_version?: number
          created_at?: string
          detected_minutes: number
          employee_id: string
          id?: string
          is_current?: boolean
          late_arrival_policy_id: string
          scheduled_start: string
          work_date: string
        }
        Update: {
          actual_start?: string
          attendance_record_id?: string
          calculated_at?: string
          calculation_version?: number
          created_at?: string
          detected_minutes?: number
          employee_id?: string
          id?: string
          is_current?: boolean
          late_arrival_policy_id?: string
          scheduled_start?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "late_arrival_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_effective_punches"
            referencedColumns: ["attendance_record_id"]
          },
          {
            foreignKeyName: "late_arrival_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "late_arrival_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "late_arrival_records_late_arrival_policy_id_fkey"
            columns: ["late_arrival_policy_id"]
            isOneToOne: false
            referencedRelation: "late_arrival_policies"
            referencedColumns: ["id"]
          },
        ]
      }
      medical_license_approvals: {
        Row: {
          absence_record_id: string
          approved_at: string | null
          approved_by: string | null
          confirmed_end_date: string | null
          confirmed_start_date: string | null
          created_at: string
          extraction_status: string | null
          id: string
          is_current: boolean
          proposed_end_date: string
          proposed_start_date: string
          rejected_at: string | null
          rejected_by: string | null
          rejection_reason: string | null
          status: Database["public"]["Enums"]["medical_license_approval_status"]
          supporting_document_id: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          absence_record_id: string
          approved_at?: string | null
          approved_by?: string | null
          confirmed_end_date?: string | null
          confirmed_start_date?: string | null
          created_at?: string
          extraction_status?: string | null
          id?: string
          is_current?: boolean
          proposed_end_date: string
          proposed_start_date: string
          rejected_at?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          status?: Database["public"]["Enums"]["medical_license_approval_status"]
          supporting_document_id: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          absence_record_id?: string
          approved_at?: string | null
          approved_by?: string | null
          confirmed_end_date?: string | null
          confirmed_start_date?: string | null
          created_at?: string
          extraction_status?: string | null
          id?: string
          is_current?: boolean
          proposed_end_date?: string
          proposed_start_date?: string
          rejected_at?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          status?: Database["public"]["Enums"]["medical_license_approval_status"]
          supporting_document_id?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "medical_license_approvals_absence_record_id_fkey"
            columns: ["absence_record_id"]
            isOneToOne: false
            referencedRelation: "absence_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_license_approvals_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_license_approvals_rejected_by_fkey"
            columns: ["rejected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_license_approvals_supporting_document_id_fkey"
            columns: ["supporting_document_id"]
            isOneToOne: false
            referencedRelation: "supporting_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_license_approvals_supporting_document_id_fkey"
            columns: ["supporting_document_id"]
            isOneToOne: false
            referencedRelation: "supporting_documents_metadata"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_license_approvals_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      membership_org_scopes: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          company_id: string
          include_descendants: boolean
          membership_id: string
          org_unit_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          company_id: string
          include_descendants?: boolean
          membership_id: string
          org_unit_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          company_id?: string
          include_descendants?: boolean
          membership_id?: string
          org_unit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "membership_org_scopes_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_org_scopes_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_org_scopes_company_id_membership_id_fkey"
            columns: ["company_id", "membership_id"]
            isOneToOne: false
            referencedRelation: "company_memberships"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "membership_org_scopes_company_id_org_unit_id_fkey"
            columns: ["company_id", "org_unit_id"]
            isOneToOne: false
            referencedRelation: "organization_units"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      module_catalog: {
        Row: {
          active: boolean
          category: string
          created_at: string
          description: string
          key: string
          name: string
          sort_order: number
          tenant_isolated: boolean
        }
        Insert: {
          active?: boolean
          category: string
          created_at?: string
          description: string
          key: string
          name: string
          sort_order?: number
          tenant_isolated?: boolean
        }
        Update: {
          active?: boolean
          category?: string
          created_at?: string
          description?: string
          key?: string
          name?: string
          sort_order?: number
          tenant_isolated?: boolean
        }
        Relationships: []
      }
      onboarding_step_catalog: {
        Row: {
          active: boolean
          description: string
          key: string
          name: string
          sort_order: number
        }
        Insert: {
          active?: boolean
          description: string
          key: string
          name: string
          sort_order: number
        }
        Update: {
          active?: boolean
          description?: string
          key?: string
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      mfa_events: {
        Row: {
          created_at: string
          event_type: string
          factor_id: string | null
          id: string
          performed_by: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          factor_id?: string | null
          id?: string
          performed_by?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          factor_id?: string | null
          id?: string
          performed_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mfa_events_performed_by_fkey"
            columns: ["performed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mfa_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_unit_leads: {
        Row: {
          company_id: string
          created_at: string
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          org_unit_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          effective_from: string
          effective_to?: string | null
          employee_id: string
          id?: string
          org_unit_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          org_unit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_unit_leads_company_id_employee_id_fkey"
            columns: ["company_id", "employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "organization_unit_leads_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_unit_leads_company_id_org_unit_id_fkey"
            columns: ["company_id", "org_unit_id"]
            isOneToOne: false
            referencedRelation: "organization_units"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      organization_units: {
        Row: {
          active: boolean
          code: string
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          parent_id: string | null
          sort_order: number
          unit_type: Database["public"]["Enums"]["organization_unit_type"]
          updated_at: string
        }
        Insert: {
          active?: boolean
          code: string
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          parent_id?: string | null
          sort_order?: number
          unit_type: Database["public"]["Enums"]["organization_unit_type"]
          updated_at?: string
        }
        Update: {
          active?: boolean
          code?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          parent_id?: string | null
          sort_order?: number
          unit_type?: Database["public"]["Enums"]["organization_unit_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_units_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_units_company_id_parent_id_fkey"
            columns: ["company_id", "parent_id"]
            isOneToOne: false
            referencedRelation: "organization_units"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "organization_units_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_decisions: {
        Row: {
          approved_minutes: number
          created_at: string
          decided_at: string
          decided_by: string
          decision_status: Database["public"]["Enums"]["overtime_decision_status"]
          id: string
          is_current: boolean
          overtime_record_id: string
          reason: string | null
          rejected_minutes: number
          requires_manual_review: boolean
          system_proposed_minutes: number | null
        }
        Insert: {
          approved_minutes: number
          created_at?: string
          decided_at?: string
          decided_by?: string
          decision_status: Database["public"]["Enums"]["overtime_decision_status"]
          id?: string
          is_current?: boolean
          overtime_record_id: string
          reason?: string | null
          rejected_minutes: number
          requires_manual_review?: boolean
          system_proposed_minutes?: number | null
        }
        Update: {
          approved_minutes?: number
          created_at?: string
          decided_at?: string
          decided_by?: string
          decision_status?: Database["public"]["Enums"]["overtime_decision_status"]
          id?: string
          is_current?: boolean
          overtime_record_id?: string
          reason?: string | null
          rejected_minutes?: number
          requires_manual_review?: boolean
          system_proposed_minutes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "overtime_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_decisions_overtime_record_id_fkey"
            columns: ["overtime_record_id"]
            isOneToOne: false
            referencedRelation: "overtime_records"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_policies: {
        Row: {
          created_at: string
          day_of_week: number
          effective_from: string
          effective_to: string | null
          employee_group_id: string
          id: string
          max_overtime_minutes: number | null
          overtime_eligible: boolean
        }
        Insert: {
          created_at?: string
          day_of_week: number
          effective_from: string
          effective_to?: string | null
          employee_group_id: string
          id?: string
          max_overtime_minutes?: number | null
          overtime_eligible: boolean
        }
        Update: {
          created_at?: string
          day_of_week?: number
          effective_from?: string
          effective_to?: string | null
          employee_group_id?: string
          id?: string
          max_overtime_minutes?: number | null
          overtime_eligible?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "overtime_policies_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_records: {
        Row: {
          attendance_record_id: string
          calculated_at: string
          calculation_version: number
          candidate_minutes: number
          created_at: string
          employee_id: string
          id: string
          is_current: boolean
          overtime_policy_id: string
          overtime_type_id: string
          work_date: string
        }
        Insert: {
          attendance_record_id: string
          calculated_at?: string
          calculation_version?: number
          candidate_minutes: number
          created_at?: string
          employee_id: string
          id?: string
          is_current?: boolean
          overtime_policy_id: string
          overtime_type_id: string
          work_date: string
        }
        Update: {
          attendance_record_id?: string
          calculated_at?: string
          calculation_version?: number
          candidate_minutes?: number
          created_at?: string
          employee_id?: string
          id?: string
          is_current?: boolean
          overtime_policy_id?: string
          overtime_type_id?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "overtime_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_effective_punches"
            referencedColumns: ["attendance_record_id"]
          },
          {
            foreignKeyName: "overtime_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_records_overtime_policy_id_fkey"
            columns: ["overtime_policy_id"]
            isOneToOne: false
            referencedRelation: "overtime_policies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_records_overtime_type_id_fkey"
            columns: ["overtime_type_id"]
            isOneToOne: false
            referencedRelation: "overtime_types"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_types: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      payroll_batch_items: {
        Row: {
          batch_id: string
          created_at: string
          id: string
          nombre_cliente: string
          nro_docto: string
          status: string
          supplier_id: string | null
          valor_total: number
        }
        Insert: {
          batch_id: string
          created_at?: string
          id?: string
          nombre_cliente: string
          nro_docto: string
          status: string
          supplier_id?: string | null
          valor_total: number
        }
        Update: {
          batch_id?: string
          created_at?: string
          id?: string
          nombre_cliente?: string
          nro_docto?: string
          status?: string
          supplier_id?: string | null
          valor_total?: number
        }
        Relationships: [
          {
            foreignKeyName: "payroll_batch_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "payroll_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_batch_items_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_batches: {
        Row: {
          generated_at: string
          generated_by: string
          id: string
          matched_count: number
          source_filename: string
          total_amount: number
          unmatched_count: number
        }
        Insert: {
          generated_at?: string
          generated_by: string
          id?: string
          matched_count: number
          source_filename: string
          total_amount: number
          unmatched_count: number
        }
        Update: {
          generated_at?: string
          generated_by?: string
          id?: string
          matched_count?: number
          source_filename?: string
          total_amount?: number
          unmatched_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "payroll_batches_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      period_snapshots: {
        Row: {
          created_at: string
          generated_at: string
          generated_by: string
          id: string
          payload: Json
          reporting_period_id: string
        }
        Insert: {
          created_at?: string
          generated_at?: string
          generated_by?: string
          id?: string
          payload: Json
          reporting_period_id: string
        }
        Update: {
          created_at?: string
          generated_at?: string
          generated_by?: string
          id?: string
          payload?: Json
          reporting_period_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "period_snapshots_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "period_snapshots_reporting_period_id_fkey"
            columns: ["reporting_period_id"]
            isOneToOne: false
            referencedRelation: "reporting_periods"
            referencedColumns: ["id"]
          },
        ]
      }
      permission_definitions: {
        Row: {
          code: string
          created_at: string
          description: string
          module_key: string | null
        }
        Insert: {
          code: string
          created_at?: string
          description: string
          module_key?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          description?: string
          module_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "permission_definitions_module_key_fkey"
            columns: ["module_key"]
            isOneToOne: false
            referencedRelation: "module_catalog"
            referencedColumns: ["key"]
          },
        ]
      }
      platform_audit_log: {
        Row: {
          action: string
          actor_id: string
          company_id: string | null
          created_at: string
          id: number
          metadata: Json
          target_id: string | null
          target_type: string
        }
        Insert: {
          action: string
          actor_id: string
          company_id?: string | null
          created_at?: string
          id?: never
          metadata?: Json
          target_id?: string | null
          target_type: string
        }
        Update: {
          action?: string
          actor_id?: string
          company_id?: string | null
          created_at?: string
          id?: never
          metadata?: Json
          target_id?: string | null
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_audit_log_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_memberships: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          role: Database["public"]["Enums"]["platform_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          role: Database["public"]["Enums"]["platform_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          role?: Database["public"]["Enums"]["platform_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_memberships_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean
          created_at: string
          display_name: string
          id: string
          medical_license_approver: boolean
          role: Database["public"]["Enums"]["app_role"] | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_name: string
          id?: string
          medical_license_approver?: boolean
          role?: Database["public"]["Enums"]["app_role"] | null
        }
        Update: {
          active?: boolean
          created_at?: string
          display_name?: string
          id?: string
          medical_license_approver?: boolean
          role?: Database["public"]["Enums"]["app_role"] | null
        }
        Relationships: []
      }
      reporting_lines: {
        Row: {
          company_id: string
          created_at: string
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          is_primary: boolean
          manager_employee_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          effective_from: string
          effective_to?: string | null
          employee_id: string
          id?: string
          is_primary?: boolean
          manager_employee_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          is_primary?: boolean
          manager_employee_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reporting_lines_company_id_employee_id_fkey"
            columns: ["company_id", "employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "reporting_lines_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reporting_lines_company_id_manager_employee_id_fkey"
            columns: ["company_id", "manager_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      reporting_periods: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          created_at: string
          id: string
          period_end: string
          period_start: string
          reopen_reason: string | null
          reopened_at: string | null
          reopened_by: string | null
          status: Database["public"]["Enums"]["reporting_period_status"]
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          period_end: string
          period_start: string
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          status?: Database["public"]["Enums"]["reporting_period_status"]
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          period_end?: string
          period_start?: string
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          status?: Database["public"]["Enums"]["reporting_period_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reporting_periods_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reporting_periods_reopened_by_fkey"
            columns: ["reopened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rule_engine_runs: {
        Row: {
          attendance_derived: number
          company_id: string
          early_departure_candidates: number
          employees_processed: number
          error_summary: string | null
          failure_count: number
          finished_at: string | null
          id: string
          late_candidates: number
          overtime_candidates: number
          started_at: string
          status: string
          triggered_by: string
          triggered_by_profile: string | null
          without_schedule: number
          work_date: string
        }
        Insert: {
          attendance_derived?: number
          company_id?: string
          early_departure_candidates?: number
          employees_processed?: number
          error_summary?: string | null
          failure_count?: number
          finished_at?: string | null
          id?: string
          late_candidates?: number
          overtime_candidates?: number
          started_at?: string
          status: string
          triggered_by: string
          triggered_by_profile?: string | null
          without_schedule?: number
          work_date: string
        }
        Update: {
          attendance_derived?: number
          company_id?: string
          early_departure_candidates?: number
          employees_processed?: number
          error_summary?: string | null
          failure_count?: number
          finished_at?: string | null
          id?: string
          late_candidates?: number
          overtime_candidates?: number
          started_at?: string
          status?: string
          triggered_by?: string
          triggered_by_profile?: string | null
          without_schedule?: number
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "rule_engine_runs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rule_engine_runs_triggered_by_profile_fkey"
            columns: ["triggered_by_profile"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_assignments: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          work_schedule_id: string
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          employee_id: string
          id?: string
          work_schedule_id: string
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          work_schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_assignments_work_schedule_id_fkey"
            columns: ["work_schedule_id"]
            isOneToOne: false
            referencedRelation: "work_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      supervisor_assignments: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          source: string
          supervisor_profile_id: string
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          employee_id: string
          id?: string
          source?: string
          supervisor_profile_id: string
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          source?: string
          supervisor_profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supervisor_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supervisor_assignments_supervisor_profile_id_fkey"
            columns: ["supervisor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_master_imports: {
        Row: {
          activated_at: string | null
          created_at: string
          file_size: number
          id: string
          inserted_count: number
          original_filename: string
          rejected_count: number
          replaced_at: string | null
          replaces_import_id: string | null
          row_count: number
          status: Database["public"]["Enums"]["supplier_master_import_status"]
          storage_path: string | null
          unchanged_count: number
          updated_count: number
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          activated_at?: string | null
          created_at?: string
          file_size: number
          id?: string
          inserted_count?: number
          original_filename: string
          rejected_count?: number
          replaced_at?: string | null
          replaces_import_id?: string | null
          row_count: number
          status?: Database["public"]["Enums"]["supplier_master_import_status"]
          storage_path?: string | null
          unchanged_count?: number
          updated_count?: number
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          activated_at?: string | null
          created_at?: string
          file_size?: number
          id?: string
          inserted_count?: number
          original_filename?: string
          rejected_count?: number
          replaced_at?: string | null
          replaces_import_id?: string | null
          row_count?: number
          status?: Database["public"]["Enums"]["supplier_master_import_status"]
          storage_path?: string | null
          unchanged_count?: number
          updated_count?: number
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_master_imports_replaces_import_id_fkey"
            columns: ["replaces_import_id"]
            isOneToOne: false
            referencedRelation: "supplier_master_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_master_imports_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          account_number: string
          active: boolean
          bank_code: string
          created_at: string
          created_by: string
          id: string
          name: string
          normalized_name: string
          normalized_rut: string
          payment_method: string
          rut: string
          updated_at: string
        }
        Insert: {
          account_number: string
          active?: boolean
          bank_code: string
          created_at?: string
          created_by: string
          id?: string
          name: string
          normalized_name: string
          normalized_rut: string
          payment_method: string
          rut: string
          updated_at?: string
        }
        Update: {
          account_number?: string
          active?: boolean
          bank_code?: string
          created_at?: string
          created_by?: string
          id?: string
          name?: string
          normalized_name?: string
          normalized_rut?: string
          payment_method?: string
          rut?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "suppliers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      supporting_documents: {
        Row: {
          absence_record_id: string | null
          attendance_status_record_id: string | null
          created_at: string
          document_type: string
          early_departure_record_id: string | null
          employee_id: string
          id: string
          late_arrival_decision_id: string | null
          mime_type: string
          original_filename: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          absence_record_id?: string | null
          attendance_status_record_id?: string | null
          created_at?: string
          document_type: string
          early_departure_record_id?: string | null
          employee_id: string
          id?: string
          late_arrival_decision_id?: string | null
          mime_type: string
          original_filename: string
          storage_path: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Update: {
          absence_record_id?: string | null
          attendance_status_record_id?: string | null
          created_at?: string
          document_type?: string
          early_departure_record_id?: string | null
          employee_id?: string
          id?: string
          late_arrival_decision_id?: string | null
          mime_type?: string
          original_filename?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "supporting_documents_absence_record_id_fkey"
            columns: ["absence_record_id"]
            isOneToOne: false
            referencedRelation: "absence_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_attendance_status_record_id_fkey"
            columns: ["attendance_status_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_status_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_early_departure_record_id_fkey"
            columns: ["early_departure_record_id"]
            isOneToOne: false
            referencedRelation: "early_departure_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_late_arrival_decision_id_fkey"
            columns: ["late_arrival_decision_id"]
            isOneToOne: false
            referencedRelation: "late_arrival_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_runs: {
        Row: {
          attempt: number
          company_id: string
          created_at: string
          error_category: string | null
          error_summary: Json | null
          finished_at: string | null
          id: string
          records_conflicted: number
          records_created: number
          records_read: number
          records_unchanged: number
          records_updated: number
          retry_of: string | null
          started_at: string
          status: Database["public"]["Enums"]["sync_run_status"]
          target_period_end: string | null
          target_period_start: string | null
          triggered_by: string
        }
        Insert: {
          attempt?: number
          company_id?: string
          created_at?: string
          error_category?: string | null
          error_summary?: Json | null
          finished_at?: string | null
          id?: string
          records_conflicted?: number
          records_created?: number
          records_read?: number
          records_unchanged?: number
          records_updated?: number
          retry_of?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["sync_run_status"]
          target_period_end?: string | null
          target_period_start?: string | null
          triggered_by?: string
        }
        Update: {
          attempt?: number
          company_id?: string
          created_at?: string
          error_category?: string | null
          error_summary?: Json | null
          finished_at?: string | null
          id?: string
          records_conflicted?: number
          records_created?: number
          records_read?: number
          records_unchanged?: number
          records_updated?: number
          retry_of?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["sync_run_status"]
          target_period_end?: string | null
          target_period_start?: string | null
          triggered_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_runs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_runs_retry_of_fkey"
            columns: ["retry_of"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_review_snapshots: {
        Row: {
          created_at: string
          generated_at: string
          generated_by: string
          id: string
          payload: Json
          weekly_review_id: string
        }
        Insert: {
          created_at?: string
          generated_at?: string
          generated_by?: string
          id?: string
          payload: Json
          weekly_review_id: string
        }
        Update: {
          created_at?: string
          generated_at?: string
          generated_by?: string
          id?: string
          payload?: Json
          weekly_review_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_review_snapshots_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_review_snapshots_weekly_review_id_fkey"
            columns: ["weekly_review_id"]
            isOneToOne: false
            referencedRelation: "weekly_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_reviews: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          created_at: string
          id: string
          period_end: string
          period_start: string
          reopen_reason: string | null
          reopened_at: string | null
          reopened_by: string | null
          reporting_period_id: string | null
          status: Database["public"]["Enums"]["weekly_review_status"]
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          period_end: string
          period_start: string
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          reporting_period_id?: string | null
          status?: Database["public"]["Enums"]["weekly_review_status"]
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          period_end?: string
          period_start?: string
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          reporting_period_id?: string | null
          status?: Database["public"]["Enums"]["weekly_review_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_reviews_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_reviews_reopened_by_fkey"
            columns: ["reopened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_reviews_reporting_period_id_fkey"
            columns: ["reporting_period_id"]
            isOneToOne: false
            referencedRelation: "reporting_periods"
            referencedColumns: ["id"]
          },
        ]
      }
      work_schedule_rules: {
        Row: {
          created_at: string
          day_of_week: number
          id: string
          scheduled_end: string | null
          scheduled_start: string | null
          work_schedule_id: string
        }
        Insert: {
          created_at?: string
          day_of_week: number
          id?: string
          scheduled_end?: string | null
          scheduled_start?: string | null
          work_schedule_id: string
        }
        Update: {
          created_at?: string
          day_of_week?: number
          id?: string
          scheduled_end?: string | null
          scheduled_start?: string | null
          work_schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_schedule_rules_work_schedule_id_fkey"
            columns: ["work_schedule_id"]
            isOneToOne: false
            referencedRelation: "work_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      work_schedules: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      workera_attendance_events: {
        Row: {
          attendance_status: string
          attendance_timestamp_interpreted: string | null
          attendance_timestamp_raw: string
          attendance_type_code: number
          attendance_type_label: string
          checksum: string | null
          company_id: string
          created_at: string
          device_name: string | null
          employee_id: string
          external_attendance_status: string
          external_employee_code: string
          external_fingerprint: string | null
          id: string
          is_current: boolean
          origin: string | null
          origin_code: string | null
          source_version: number
          sync_run_id: string
          synced_at: string
          work_date: string
        }
        Insert: {
          attendance_status: string
          attendance_timestamp_interpreted?: string | null
          attendance_timestamp_raw: string
          attendance_type_code: number
          attendance_type_label: string
          checksum?: string | null
          company_id?: string
          created_at?: string
          device_name?: string | null
          employee_id: string
          external_attendance_status: string
          external_employee_code: string
          external_fingerprint?: string | null
          id?: string
          is_current?: boolean
          origin?: string | null
          origin_code?: string | null
          source_version?: number
          sync_run_id: string
          synced_at?: string
          work_date: string
        }
        Update: {
          attendance_status?: string
          attendance_timestamp_interpreted?: string | null
          attendance_timestamp_raw?: string
          attendance_type_code?: number
          attendance_type_label?: string
          checksum?: string | null
          company_id?: string
          created_at?: string
          device_name?: string | null
          employee_id?: string
          external_attendance_status?: string
          external_employee_code?: string
          external_fingerprint?: string | null
          id?: string
          is_current?: boolean
          origin?: string | null
          origin_code?: string | null
          source_version?: number
          sync_run_id?: string
          synced_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "workera_attendance_events_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workera_attendance_events_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workera_attendance_events_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      attendance_effective_punches: {
        Row: {
          attendance_record_id: string | null
          current_correction_id: string | null
          effective_clock_in: string | null
          effective_clock_out: string | null
          employee_id: string | null
          raw_clock_in: string | null
          raw_clock_out: string | null
          work_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attendance_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      late_arrival_daily_totals: {
        Row: {
          detected_minutes: number | null
          employee_id: string | null
          justification_status: string | null
          payroll_minutes: number | null
          work_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "late_arrival_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      supporting_documents_metadata: {
        Row: {
          absence_record_id: string | null
          attendance_status_record_id: string | null
          created_at: string | null
          document_type: string | null
          employee_id: string | null
          id: string | null
          late_arrival_decision_id: string | null
          mime_type: string | null
          original_filename: string | null
          uploaded_at: string | null
          uploaded_by: string | null
        }
        Insert: {
          absence_record_id?: string | null
          attendance_status_record_id?: string | null
          created_at?: string | null
          document_type?: string | null
          employee_id?: string | null
          id?: string | null
          late_arrival_decision_id?: string | null
          mime_type?: string | null
          original_filename?: string | null
          uploaded_at?: string | null
          uploaded_by?: string | null
        }
        Update: {
          absence_record_id?: string | null
          attendance_status_record_id?: string | null
          created_at?: string | null
          document_type?: string | null
          employee_id?: string | null
          id?: string | null
          late_arrival_decision_id?: string | null
          mime_type?: string | null
          original_filename?: string | null
          uploaded_at?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "supporting_documents_absence_record_id_fkey"
            columns: ["absence_record_id"]
            isOneToOne: false
            referencedRelation: "absence_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_attendance_status_record_id_fkey"
            columns: ["attendance_status_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_status_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_late_arrival_decision_id_fkey"
            columns: ["late_arrival_decision_id"]
            isOneToOne: false
            referencedRelation: "late_arrival_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supporting_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      accept_my_company_invitations: { Args: never; Returns: number }
      account_requires_mfa: {
        Args: { p_user: string }
        Returns: boolean
      }
      activate_colaciones_discount_workbook: {
        Args: {
          p_checksum: string
          p_file_size: number
          p_id: string
          p_original_filename: string
          p_storage_path: string
          p_uploaded_by: string
        }
        Returns: undefined
      }
      active_company_memberships: {
        Args: never
        Returns: {
          active: boolean
          company_id: string
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "company_memberships"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      apply_personnel_roster_import: {
        Args: {
          p_actor_id: string
          p_deactivate_ids: Json
          p_insert_rows: Json
          p_update_rows: Json
        }
        Returns: undefined
      }
      apply_schedule_assignment: {
        Args: {
          p_effective_from: string
          p_employee_id: string
          p_work_schedule_id: string
        }
        Returns: undefined
      }
      apply_supplier_master_import: {
        Args: {
          p_file_size: number
          p_import_id: string
          p_insert_rows: Json
          p_inserted_count: number
          p_original_filename: string
          p_rejected_count: number
          p_row_count: number
          p_storage_path: string
          p_unchanged_count: number
          p_update_rows: Json
          p_updated_count: number
          p_uploaded_by: string
        }
        Returns: undefined
      }
      approve_medical_license: {
        Args: {
          p_approval_id: string
          p_confirmed_end_date: string
          p_confirmed_start_date: string
        }
        Returns: undefined
      }
      assign_schedule_to_unassigned: {
        Args: { p_effective_from: string; p_work_schedule_id: string }
        Returns: number
      }
      attach_expense_receipt_capture: {
        Args: { p_capture_id: string; p_item_id: string }
        Returns: string
      }
      begin_expense_receipt_whatsapp_pairing: {
        Args: {
          p_company_id: string
          p_expires_at: string
          p_token_hash: string
        }
        Returns: string
      }
      can_manage_employee: { Args: { p_employee_id: string }; Returns: boolean }
      can_manage_platform: { Args: never; Returns: boolean }
      can_read_expense_capture_path: {
        Args: { p_name: string }
        Returns: boolean
      }
      can_read_expense_receipt_path: {
        Args: { p_name: string }
        Returns: boolean
      }
      can_read_mfa_events_for: {
        Args: { p_target: string }
        Returns: boolean
      }
      can_reset_mfa_for: {
        Args: { p_target: string }
        Returns: boolean
      }
      can_upload_expense_capture_path: {
        Args: { p_name: string }
        Returns: boolean
      }
      can_upload_expense_receipt_path: {
        Args: { p_name: string }
        Returns: boolean
      }
      cancel_expense_advance: {
        Args: { p_advance_id: string }
        Returns: undefined
      }
      claim_expense_accounting_exports: {
        Args: { p_limit?: number }
        Returns: {
          attempt_count: number
          company_id: string
          export_id: string
          idempotency_key: string
          lease_token: string
          payload: Json
        }[]
      }
      claim_expense_bank_upload: {
        Args: {
          p_actor_id: string
          p_company_id: string
          p_declared_bytes: number
        }
        Returns: undefined
      }
      claim_expense_ocr_jobs: {
        Args: { p_limit?: number; p_worker_id: string }
        Returns: {
          attempt: number
          company_id: string
          currency_code: string
          expense_date: string
          job_id: string
          merchant_name: string
          mime_type: string
          net_amount: number
          provider_operation_url: string
          receipt_id: string
          storage_path: string
          tax_amount: number
          total_amount: number
        }[]
      }
      claim_expense_receipt_email_event: {
        Args: {
          p_actor_id: string
          p_company_id: string
          p_provider_email_id: string
          p_provider_event_id: string
          p_reserved_slots: number
        }
        Returns: {
          claim_token: string
          result: string
        }[]
      }
      claim_expense_receipt_whatsapp_event: {
        Args: {
          p_actor_id: string
          p_company_id: string
          p_provider_message_hash: string
        }
        Returns: {
          claim_token: string
          result: string
        }[]
      }
      claim_expense_receipt_whatsapp_pairing: {
        Args: { p_token_hash: string; p_wa_id_hash: string }
        Returns: {
          company_id: string
          user_id: string
        }[]
      }
      classify_overtime_type_id: {
        Args: { p_work_date: string }
        Returns: string
      }
      cleanup_demo_data: {
        Args: never
        Returns: {
          rows_deleted: number
          table_name: string
        }[]
      }
      clear_time_control_exemption: {
        Args: { p_effective_from: string; p_employee_id: string }
        Returns: undefined
      }
      company_has_module: {
        Args: { p_company_id: string; p_module_key: string }
        Returns: boolean
      }
      complete_expense_accounting_export: {
        Args: {
          p_error_code?: string
          p_error_summary?: string
          p_export_id: string
          p_external_reference?: string
          p_lease_token: string
          p_retryable?: boolean
          p_succeeded: boolean
        }
        Returns: Database["public"]["Enums"]["expense_accounting_export_status"]
      }
      complete_expense_ocr_job: {
        Args: { p_extraction: Json; p_job_id: string; p_worker_id: string }
        Returns: undefined
      }
      complete_expense_receipt_email_event: {
        Args: {
          p_actor_id: string
          p_claim_token: string
          p_company_id: string
          p_provider_email_id: string
        }
        Returns: undefined
      }
      complete_expense_receipt_whatsapp_event: {
        Args: {
          p_actor_id: string
          p_claim_token: string
          p_company_id: string
          p_provider_message_hash: string
        }
        Returns: boolean
      }
      create_expense_report: {
        Args: {
          p_client_request_id: string
          p_company_id: string
          p_currency_code: string
          p_purpose: string | null
          p_title: string
        }
        Returns: string
      }
      current_platform_role: {
        Args: never
        Returns: Database["public"]["Enums"]["platform_role"]
      }
      current_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      decide_expense_report: {
        Args: {
          p_comment?: string
          p_decision: Database["public"]["Enums"]["expense_approval_decision"]
          p_report_id: string
        }
        Returns: undefined
      }
      defer_expense_ocr_job: {
        Args: {
          p_delay_seconds?: number
          p_job_id: string
          p_provider_operation_url: string
          p_worker_id: string
        }
        Returns: undefined
      }
      discard_expense_receipt_capture: {
        Args: { p_actor_id: string; p_capture_id: string; p_company_id: string }
        Returns: string
      }
      disconnect_expense_receipt_whatsapp: {
        Args: { p_company_id: string }
        Returns: boolean
      }
      employee_belongs_to_active_company: {
        Args: { p_employee_id: string }
        Returns: boolean
      }
      enforce_mfa_for_privileged: { Args: never; Returns: undefined }
      employee_group_belongs_to_active_company: {
        Args: { p_employee_group_id: string }
        Returns: boolean
      }
      ensure_expense_receipt_email_alias: {
        Args: { p_company_id: string }
        Returns: string
      }
      expense_actor_has_permission: {
        Args: {
          p_actor_id: string
          p_company_id: string
          p_permission_code: string
        }
        Returns: boolean
      }
      expense_dashboard_summary: {
        Args: { p_company_id: string }
        Returns: {
          approved_count: number
          draft_count: number
          review_count: number
          visible_total: number
        }[]
      }
      expense_policy_category_limits_valid: {
        Args: { p_rules: Json }
        Returns: boolean
      }
      fail_expense_ocr_job: {
        Args: {
          p_error_category: string
          p_error_summary: string
          p_job_id: string
          p_retry_delay_seconds?: number
          p_retryable: boolean
          p_worker_id: string
        }
        Returns: boolean
      }
      get_expense_indicators: {
        Args: { p_company_id: string; p_window_days?: number }
        Returns: Json
      }
      grant_expense_advance: {
        Args: {
          p_amount: number
          p_company_id: string
          p_currency_code: string
          p_purpose: string
          p_recipient_id: string
        }
        Returns: string
      }
      has_company_permission: {
        Args: { p_company_id: string; p_permission_code: string }
        Returns: boolean
      }
      has_employee_group_company_permission: {
        Args: { p_employee_group_id: string; p_permission_code: string }
        Returns: boolean
      }
      ignore_expense_bank_transaction: {
        Args: { p_reason: string; p_transaction_id: string }
        Returns: undefined
      }
      import_expense_bank_statement: {
        Args: {
          p_actor_id: string
          p_company_id: string
          p_rows: Json
          p_source_channel: string
        }
        Returns: string
      }
      is_active_company_member: {
        Args: { p_company_id: string }
        Returns: boolean
      }
      is_admin_rrhh: { Args: never; Returns: boolean }
      is_corporate_user: { Args: never; Returns: boolean }
      is_medical_license_approver: { Args: never; Returns: boolean }
      is_platform_admin: { Args: never; Returns: boolean }
      is_privileged_admin: { Args: never; Returns: boolean }
      is_super_admin: { Args: never; Returns: boolean }
      is_supervisor_installation: { Args: never; Returns: boolean }
      is_supervisor_production: { Args: never; Returns: boolean }
      link_expense_report_to_advance: {
        Args: { p_advance_id: string | null; p_report_id: string }
        Returns: undefined
      }
      list_expense_accounting_ready_reports: {
        Args: { p_company_id: string }
        Returns: {
          currency_code: string
          paid_at: string
          reference_number: string
          report_id: string
          title: string
          total_amount: number
        }[]
      }
      list_expense_reconciliation_candidates: {
        Args: { p_company_id: string; p_transaction_id: string }
        Returns: {
          currency_code: string
          date_distance_days: number
          reference_number: string
          report_id: string
          score: number
          submitted_at: string
          submitter_name: string
          title: string
          total_amount: number
        }[]
      }
      match_expense_bank_transaction: {
        Args: {
          p_method?: string
          p_report_id: string
          p_transaction_id: string
        }
        Returns: undefined
      }
      max_approvable_overtime_minutes: {
        Args: {
          p_employee_group_code: string
          p_overtime_type_id: string
          p_work_date: string
        }
        Returns: number
      }
      platform_assign_company_role: {
        Args: { p_membership_id: string; p_role_id: string }
        Returns: undefined
      }
      platform_company_organization: {
        Args: { p_company_id: string }
        Returns: {
          direct_member_count: number
          has_leader: boolean
          name: string
          parent_id: string
          sort_order: number
          unit_id: string
          unit_type: Database["public"]["Enums"]["organization_unit_type"]
        }[]
      }
      platform_company_portfolio: {
        Args: never
        Returns: {
          active_members: number
          available_modules: number
          company_id: string
          completed_steps: number
          created_at: string
          employee_count: number
          enabled_modules: number
          legal_name: string
          name: string
          next_step_label: string
          plan_code: string
          slug: string
          status: Database["public"]["Enums"]["company_lifecycle_status"]
          total_members: number
          total_steps: number
          workspace_enabled: boolean
        }[]
      }
      platform_company_portfolio_page: {
        Args: {
          p_company_id?: string
          p_limit?: number
          p_offset?: number
          p_search?: string
          p_status?: Database["public"]["Enums"]["company_lifecycle_status"]
        }
        Returns: {
          active_members: number
          available_modules: number
          company_id: string
          completed_steps: number
          created_at: string
          employee_count: number
          enabled_modules: number
          legal_name: string
          name: string
          next_step_label: string
          onboarding_blocked: boolean
          plan_code: string
          slug: string
          status: Database["public"]["Enums"]["company_lifecycle_status"]
          total_count: number
          total_members: number
          total_steps: number
          workspace_enabled: boolean
        }[]
      }
      platform_create_company: {
        Args: {
          p_country_code?: string
          p_legal_name?: string
          p_name: string
          p_plan_code?: string
          p_primary_contact_email?: string
          p_primary_contact_name?: string
          p_slug: string
          p_timezone?: string
        }
        Returns: string
      }
      platform_create_company_invitation: {
        Args: {
          p_company_id: string
          p_email: string
          p_expires_at?: string
          p_role_id: string
        }
        Returns: string
      }
      platform_create_organization_unit: {
        Args: {
          p_code: string
          p_company_id: string
          p_name: string
          p_parent_id: string
          p_sort_order?: number
          p_unit_type: Database["public"]["Enums"]["organization_unit_type"]
        }
        Returns: string
      }
      platform_mark_company_invitation_delivery: {
        Args: {
          p_delivery_status: string
          p_error_code?: string
          p_invitation_id: string
        }
        Returns: undefined
      }
      platform_portfolio_summary: {
        Args: never
        Returns: {
          active_companies: number
          active_members: number
          blocked_onboarding_companies: number
          enabled_modules: number
          onboarding_companies: number
          pending_invitations: number
          setup_required_modules: number
          suspended_companies: number
          total_companies: number
        }[]
      }
      platform_set_company_module_status: {
        Args: {
          p_company_id: string
          p_module_key: string
          p_status: Database["public"]["Enums"]["company_module_status"]
        }
        Returns: undefined
      }
      platform_set_onboarding_step_completed: {
        Args: { p_company_id: string; p_completed: boolean; p_step_key: string }
        Returns: undefined
      }
      production_two_hour_proposal_minutes: {
        Args: { p_candidate_minutes: number }
        Returns: number
      }
      production_two_hour_requires_manual_review: {
        Args: { p_candidate_minutes: number }
        Returns: boolean
      }
      provision_company_control_plane: {
        Args: { p_company_id: string }
        Returns: undefined
      }
      provision_expense_defaults: {
        Args: { p_actor_id: string; p_company_id: string }
        Returns: undefined
      }
      queue_expense_accounting_export: {
        Args: { p_company_id: string; p_report_id: string }
        Returns: string
      }
      reclaim_stale_expense_ocr_jobs: {
        Args: { p_stale_after_seconds?: number }
        Returns: number
      }
      reclaim_stale_rule_engine_runs: {
        Args: { p_stale_after_seconds?: number }
        Returns: number
      }
      reclaim_stale_workera_sync_runs: {
        Args: { p_stale_after_seconds?: number }
        Returns: number
      }
      recompute_employee_daily_bonus: {
        Args: { p_employee_id: string; p_work_date: string }
        Returns: undefined
      }
      reconcile_expense_report: {
        Args: { p_payment_reference: string; p_report_id: string }
        Returns: undefined
      }
      register_expense_receipt: {
        Args: {
          p_checksum_sha256: string
          p_file_size: number
          p_item_id: string
          p_mime_type: string
          p_original_filename: string
          p_storage_path: string
        }
        Returns: string
      }
      register_expense_receipt_capture: {
        Args: {
          p_actor_id: string
          p_checksum_sha256: string
          p_company_id: string
          p_file_size: number
          p_mime_type: string
          p_original_filename: string
          p_source: string
          p_storage_path: string
        }
        Returns: string
      }
      register_expense_receipt_trusted: {
        Args: {
          p_actor_id: string
          p_checksum_sha256: string
          p_company_id: string
          p_file_size: number
          p_item_id: string
          p_mime_type: string
          p_original_filename: string
          p_storage_path: string
        }
        Returns: string
      }
      register_expense_receipt_whatsapp_capture: {
        Args: {
          p_actor_id: string
          p_checksum_sha256: string
          p_claim_token: string
          p_company_id: string
          p_file_size: number
          p_mime_type: string
          p_original_filename: string
          p_provider_message_hash: string
          p_storage_path: string
        }
        Returns: string
      }
      register_inbound_expense_receipt_capture: {
        Args: {
          p_actor_id: string
          p_checksum_sha256: string
          p_claim_token: string
          p_company_id: string
          p_external_message_id: string
          p_file_size: number
          p_mime_type: string
          p_original_filename: string
          p_provider_email_id: string
          p_storage_path: string
        }
        Returns: string
      }
      reject_medical_license: {
        Args: { p_approval_id: string; p_reason: string }
        Returns: undefined
      }
      request_is_aal2: { Args: never; Returns: boolean }
      release_expense_receipt_email_event: {
        Args: {
          p_actor_id: string
          p_claim_token: string
          p_company_id: string
          p_provider_email_id: string
        }
        Returns: undefined
      }
      release_expense_receipt_whatsapp_event: {
        Args: {
          p_actor_id: string
          p_claim_token: string
          p_company_id: string
          p_provider_message_hash: string
        }
        Returns: boolean
      }
      reserve_expense_receipt_email_bytes: {
        Args: {
          p_actor_id: string
          p_claim_token: string
          p_company_id: string
          p_provider_email_id: string
          p_reserved_bytes: number
        }
        Returns: boolean
      }
      reserve_expense_receipt_whatsapp_bytes: {
        Args: {
          p_actor_id: string
          p_claim_token: string
          p_company_id: string
          p_provider_message_hash: string
          p_reserved_bytes: number
        }
        Returns: boolean
      }
      resolve_expense_receipt_email_alias: {
        Args: { p_alias_token: string }
        Returns: {
          company_id: string
          user_id: string
        }[]
      }
      resolve_expense_receipt_whatsapp_sender: {
        Args: { p_wa_id_hash: string }
        Returns: {
          company_id: string
          user_id: string
        }[]
      }
      review_expense_receipt_extraction: {
        Args: {
          p_comment?: string
          p_decision: Database["public"]["Enums"]["expense_ocr_review_decision"]
          p_receipt_id: string
        }
        Returns: string
      }
      session_requires_mfa: { Args: never; Returns: boolean }
      rotate_expense_receipt_email_alias: {
        Args: { p_company_id: string }
        Returns: string
      }
      set_time_control_exemption: {
        Args: {
          p_actor_id: string
          p_effective_from: string
          p_employee_id: string
          p_legal_basis: string
          p_reason: string
        }
        Returns: undefined
      }
      settle_expense_advance: {
        Args: { p_advance_id: string }
        Returns: undefined
      }
      submit_expense_report: {
        Args: { p_report_id: string }
        Returns: undefined
      }
      upsert_work_schedule: {
        Args: { p_name: string; p_rules: Json; p_schedule_id: string }
        Returns: string
      }
      withdraw_expense_report: {
        Args: { p_report_id: string }
        Returns: undefined
      }
    }
    Enums: {
      app_role:
        | "ADMIN_RRHH"
        | "SUPERVISOR_PRODUCTION"
        | "SUPERVISOR_INSTALLATION"
        | "SUPER_ADMIN"
      company_invitation_status: "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED"
      company_lifecycle_status:
        | "ACTIVE"
        | "ONBOARDING"
        | "SUSPENDED"
        | "INACTIVE"
      company_module_status: "ENABLED" | "DISABLED" | "PILOT" | "SETUP_REQUIRED"
      company_onboarding_status:
        | "NOT_STARTED"
        | "IN_PROGRESS"
        | "BLOCKED"
        | "COMPLETE"
      daily_review_status:
        | "IMPORTED"
        | "PENDING_REVIEW"
        | "REVIEWED"
        | "NEEDS_REVIEW"
        | "SYNC_CONFLICT"
        | "CORRECTED_AFTER_REVIEW"
        | "READY_FOR_WEEKLY_CLOSE"
      expense_accounting_export_status:
        | "QUEUED"
        | "PROCESSING"
        | "RETRY"
        | "SUCCEEDED"
        | "FAILED"
        | "CANCELLED"
      expense_advance_status: "PENDING" | "SETTLED" | "CANCELLED"
      expense_approval_decision: "APPROVED" | "REJECTED" | "RETURNED"
      expense_bank_transaction_status: "UNMATCHED" | "MATCHED" | "IGNORED"
      expense_ocr_job_status:
        | "QUEUED"
        | "RUNNING"
        | "WAITING_PROVIDER"
        | "SUCCEEDED"
        | "FAILED"
        | "CANCELLED"
      expense_ocr_review_decision: "ACCEPTED" | "REJECTED"
      expense_receipt_status:
        | "NOT_PROVIDED"
        | "UPLOADED"
        | "PROCESSING"
        | "PROCESSED"
        | "FAILED"
      expense_report_status:
        | "DRAFT"
        | "SUBMITTED"
        | "IN_REVIEW"
        | "APPROVED"
        | "REJECTED"
        | "PAID"
        | "CANCELLED"
      medical_license_approval_status:
        | "PENDING_RRHH_APPROVAL"
        | "APPROVED"
        | "REJECTED"
      missing_punch_status:
        | "PENDING_CONTACT"
        | "CONTACTED"
        | "RESOLVED"
        | "UNRESOLVED"
      missing_punch_type:
        | "MISSING_CLOCK_IN"
        | "MISSING_CLOCK_OUT"
        | "MISSING_BOTH"
      organization_unit_type:
        | "COMPANY"
        | "DIVISION"
        | "AREA"
        | "DEPARTMENT"
        | "TEAM"
        | "OTHER"
      overtime_decision_status:
        | "FULLY_APPROVED"
        | "PARTIALLY_APPROVED"
        | "REJECTED"
      platform_role: "OWNER" | "ADMIN" | "SUPPORT" | "VIEWER"
      reporting_period_status:
        | "OPEN"
        | "IN_REVIEW"
        | "READY_TO_CLOSE"
        | "CLOSED"
        | "REOPENED"
      supplier_master_import_status:
        | "VALIDATING"
        | "READY"
        | "IMPORTING"
        | "ACTIVE"
        | "REPLACED"
        | "FAILED"
      sync_run_status: "RUNNING" | "SUCCEEDED" | "FAILED" | "PARTIAL"
      weekly_review_status: "OPEN" | "READY_TO_CLOSE" | "CLOSED" | "REOPENED"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: [
        "ADMIN_RRHH",
        "SUPERVISOR_PRODUCTION",
        "SUPERVISOR_INSTALLATION",
        "SUPER_ADMIN",
      ],
      company_invitation_status: ["PENDING", "ACCEPTED", "EXPIRED", "REVOKED"],
      company_lifecycle_status: [
        "ACTIVE",
        "ONBOARDING",
        "SUSPENDED",
        "INACTIVE",
      ],
      company_module_status: ["ENABLED", "DISABLED", "PILOT", "SETUP_REQUIRED"],
      company_onboarding_status: [
        "NOT_STARTED",
        "IN_PROGRESS",
        "BLOCKED",
        "COMPLETE",
      ],
      daily_review_status: [
        "IMPORTED",
        "PENDING_REVIEW",
        "REVIEWED",
        "NEEDS_REVIEW",
        "SYNC_CONFLICT",
        "CORRECTED_AFTER_REVIEW",
        "READY_FOR_WEEKLY_CLOSE",
      ],
      expense_accounting_export_status: [
        "QUEUED",
        "PROCESSING",
        "RETRY",
        "SUCCEEDED",
        "FAILED",
        "CANCELLED",
      ],
      expense_advance_status: ["PENDING", "SETTLED", "CANCELLED"],
      expense_approval_decision: ["APPROVED", "REJECTED", "RETURNED"],
      expense_bank_transaction_status: ["UNMATCHED", "MATCHED", "IGNORED"],
      expense_ocr_job_status: [
        "QUEUED",
        "RUNNING",
        "WAITING_PROVIDER",
        "SUCCEEDED",
        "FAILED",
        "CANCELLED",
      ],
      expense_ocr_review_decision: ["ACCEPTED", "REJECTED"],
      expense_receipt_status: [
        "NOT_PROVIDED",
        "UPLOADED",
        "PROCESSING",
        "PROCESSED",
        "FAILED",
      ],
      expense_report_status: [
        "DRAFT",
        "SUBMITTED",
        "IN_REVIEW",
        "APPROVED",
        "REJECTED",
        "PAID",
        "CANCELLED",
      ],
      medical_license_approval_status: [
        "PENDING_RRHH_APPROVAL",
        "APPROVED",
        "REJECTED",
      ],
      missing_punch_status: [
        "PENDING_CONTACT",
        "CONTACTED",
        "RESOLVED",
        "UNRESOLVED",
      ],
      missing_punch_type: [
        "MISSING_CLOCK_IN",
        "MISSING_CLOCK_OUT",
        "MISSING_BOTH",
      ],
      organization_unit_type: [
        "COMPANY",
        "DIVISION",
        "AREA",
        "DEPARTMENT",
        "TEAM",
        "OTHER",
      ],
      overtime_decision_status: [
        "FULLY_APPROVED",
        "PARTIALLY_APPROVED",
        "REJECTED",
      ],
      platform_role: ["OWNER", "ADMIN", "SUPPORT", "VIEWER"],
      reporting_period_status: [
        "OPEN",
        "IN_REVIEW",
        "READY_TO_CLOSE",
        "CLOSED",
        "REOPENED",
      ],
      supplier_master_import_status: [
        "VALIDATING",
        "READY",
        "IMPORTING",
        "ACTIVE",
        "REPLACED",
        "FAILED",
      ],
      sync_run_status: ["RUNNING", "SUCCEEDED", "FAILED", "PARTIAL"],
      weekly_review_status: ["OPEN", "READY_TO_CLOSE", "CLOSED", "REOPENED"],
    },
  },
} as const
