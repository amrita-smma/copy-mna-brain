'use client';

import DashboardLayout from '@/components/layout/DashboardLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  Building,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  Search,
  Trash2,
  User,
  Users,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  type: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ContactMessage {
  id: string;
  contact_id: string;
  direction: string;
  subject: string | null;
  body: string;
  sent_at: string | null;
  from_email: string | null;
  to_email: string | null;
  created_at: string;
}

interface ContactWithMessages extends Contact {
  messages: ContactMessage[];
  message_count: number;
}

interface CRMProps {
  showCrm?: boolean;
  showAiWorkforce?: boolean;
  showVaultSync?: boolean;
}

export default function CRM({ showCrm = false, showAiWorkforce = false, showVaultSync = false }: CRMProps) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedContact, setExpandedContact] = useState<string | null>(null);
  const [contactDetails, setContactDetails] = useState<Record<string, ContactWithMessages>>({});
  const [loadingDetails, setLoadingDetails] = useState<string | null>(null);

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [vaultSyncing, setVaultSyncing] = useState(false);
  const [newContact, setNewContact] = useState({
    name: '',
    email: '',
    phone: '',
    company: '',
    title: '',
    type: 'external',
    notes: '',
  });

  const fetchContacts = useCallback(async () => {
    try {
      const url = searchQuery
        ? `/api/crm?q=${encodeURIComponent(searchQuery)}`
        : '/api/crm';
      const response = await fetch(url);
      const result = await response.json();

      if (result.success) {
        setContacts(result.data);
      } else {
        toast.error('Failed to load contacts');
      }
    } catch (error) {
      console.error('Error fetching contacts:', error);
      toast.error('Failed to load contacts');
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  const fetchContactDetails = async (contactId: string) => {
    if (contactDetails[contactId]) return;

    setLoadingDetails(contactId);
    try {
      const response = await fetch(`/api/crm/${contactId}`);
      const result = await response.json();

      if (result.success) {
        setContactDetails(prev => ({
          ...prev,
          [contactId]: result.data,
        }));
      }
    } catch (error) {
      console.error('Error fetching contact details:', error);
    } finally {
      setLoadingDetails(null);
    }
  };

  const handleToggleExpand = (contactId: string) => {
    if (expandedContact === contactId) {
      setExpandedContact(null);
    } else {
      setExpandedContact(contactId);
      fetchContactDetails(contactId);
    }
  };

  const handleCreateContact = async () => {
    if (!newContact.name.trim()) {
      toast.error('Name is required');
      return;
    }

    setCreating(true);
    try {
      const response = await fetch('/api/crm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newContact),
      });

      const result = await response.json();

      if (result.success) {
        toast.success('Contact created successfully');
        setNewContact({
          name: '',
          email: '',
          phone: '',
          company: '',
          title: '',
          type: 'external',
          notes: '',
        });
        setIsCreateDialogOpen(false);
        fetchContacts();
      } else {
        toast.error(result.error || 'Failed to create contact');
      }
    } catch (error) {
      console.error('Error creating contact:', error);
      toast.error('Failed to create contact');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteContact = async (contactId: string) => {
    try {
      const response = await fetch(`/api/crm/${contactId}`, {
        method: 'DELETE',
      });

      const result = await response.json();

      if (result.success) {
        toast.success('Contact deleted');
        fetchContacts();
      } else {
        toast.error(result.error || 'Failed to delete contact');
      }
    } catch (error) {
      console.error('Error deleting contact:', error);
      toast.error('Failed to delete contact');
    }
  };

  const handleVaultSync = async () => {
    setVaultSyncing(true);
    try {
      const response = await fetch('/api/crm/vault-export', { method: 'POST' });
      const result = await response.json();
      if (response.ok) {
        toast.success('Vault email sync started. Messages will appear once the export completes.');
      } else {
        toast.error(result.error || 'Failed to start vault sync');
      }
    } catch (error) {
      console.error('Error starting vault sync:', error);
      toast.error('Failed to start vault sync');
    } finally {
      setVaultSyncing(false);
    }
  };

  const getTypeColor = (type: string | null) => {
    switch (type) {
      case 'internal':
        return 'bg-blue-500/10 text-blue-600 border-blue-200';
      case 'external':
      default:
        return 'bg-green-500/10 text-green-600 border-green-200';
    }
  };

  if (loading) {
    return (
      <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
      <div className="flex flex-col h-full p-6 space-y-6 animate-fade-in">
        {/* Header */}
        <div className="relative flex-shrink-0">
          <div className="absolute -inset-2 rounded-2xl opacity-20 blur-xl transition-colors duration-500 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />
          <div className="relative flex items-center gap-5">
            <div className="relative group">
              <div className="absolute inset-0 rounded-2xl blur-md opacity-60 group-hover:opacity-80 transition-opacity bg-gradient-to-br from-indigo-400 to-purple-600" />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl shadow-xl transition-all duration-300 group-hover:scale-105 bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-600">
                <Users className="h-7 w-7 text-white drop-shadow-lg" />
                <div
                  className="absolute inset-0 rounded-2xl animate-ping opacity-20 bg-indigo-400"
                  style={{ animationDuration: '3s' }}
                />
              </div>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text">
                  CRM
                </h1>
                <Badge
                  variant="outline"
                  className="text-xs font-medium px-2 py-0.5 border-0 bg-indigo-500/10 text-indigo-600 hover:bg-indigo-500/20"
                >
                  <Zap className="h-3 w-3 mr-1" />
                  Contact Management
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm">
                Manage contacts and view communication history
              </p>
            </div>
          </div>
        </div>

        {/* Actions Bar */}
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search contacts..."
              className="pl-10"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            {showVaultSync && (
              <Button variant="outline" onClick={handleVaultSync} disabled={vaultSyncing}>
                {vaultSyncing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4 mr-2" />
                    Sync Email (1d)
                  </>
                )}
              </Button>
            )}
            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Contact
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Contact</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    value={newContact.name}
                    onChange={(e) => setNewContact(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="John Doe"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={newContact.email}
                      onChange={(e) => setNewContact(prev => ({ ...prev, email: e.target.value }))}
                      placeholder="john@example.com"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="phone">Phone</Label>
                    <Input
                      id="phone"
                      value={newContact.phone}
                      onChange={(e) => setNewContact(prev => ({ ...prev, phone: e.target.value }))}
                      placeholder="+1 234 567 890"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="company">Company</Label>
                    <Input
                      id="company"
                      value={newContact.company}
                      onChange={(e) => setNewContact(prev => ({ ...prev, company: e.target.value }))}
                      placeholder="Acme Corp"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="title">Title</Label>
                    <Input
                      id="title"
                      value={newContact.title}
                      onChange={(e) => setNewContact(prev => ({ ...prev, title: e.target.value }))}
                      placeholder="Managing Director"
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="type">Type</Label>
                  <Select
                    value={newContact.type}
                    onValueChange={(value) => setNewContact(prev => ({ ...prev, type: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="external">External (Banker/Client)</SelectItem>
                      <SelectItem value="internal">Internal (StarCapital)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea
                    id="notes"
                    value={newContact.notes}
                    onChange={(e) => setNewContact(prev => ({ ...prev, notes: e.target.value }))}
                    placeholder="Additional notes about the contact..."
                    rows={3}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreateContact} disabled={creating}>
                  {creating ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create Contact'
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          </div>
        </div>

        {/* Contacts List */}
        <Card className="flex-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Contacts ({contacts.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {contacts.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Users className="mx-auto h-12 w-12 mb-4 opacity-50" />
                <p>No contacts found</p>
                <p className="text-sm">Add your first contact to get started</p>
              </div>
            ) : (
              <div className="space-y-6">
                {Object.entries(
                  contacts
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .reduce<Record<string, Contact[]>>((groups, contact) => {
                      const letter = contact.name[0]?.toUpperCase() ?? '#';
                      (groups[letter] ??= []).push(contact);
                      return groups;
                    }, {}),
                ).sort(([a], [b]) => a.localeCompare(b)).map(([letter, group]) => (
                  <div key={letter}>
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2 px-1">
                      {letter}
                    </div>
                    <div className="space-y-2">
                {group.map((contact) => (
                  <div
                    key={contact.id}
                    className="border rounded-lg overflow-hidden"
                  >
                    {/* Contact Row */}
                    <div
                      className={cn(
                        "flex items-center gap-4 p-4 cursor-pointer hover:bg-muted/50 transition-colors",
                        expandedContact === contact.id && "bg-muted/30"
                      )}
                      onClick={() => handleToggleExpand(contact.id)}
                    >
                      <div className="flex-shrink-0">
                        {expandedContact === contact.id ? (
                          <ChevronDown className="h-5 w-5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-5 w-5 text-muted-foreground" />
                        )}
                      </div>

                      <div className="flex-shrink-0 h-10 w-10 rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center">
                        <User className="h-5 w-5 text-primary" />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium truncate">{contact.name}</p>
                          <Badge variant="outline" className={cn("text-[10px]", getTypeColor(contact.type))}>
                            {contact.type === 'internal' ? 'Internal' : 'External'}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          {contact.title && contact.company && (
                            <span className="truncate">{contact.title} at {contact.company}</span>
                          )}
                          {!contact.title && contact.company && (
                            <span className="flex items-center gap-1">
                              <Building className="h-3 w-3" />
                              {contact.company}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-4 text-sm text-muted-foreground">
                        {contact.email && (
                          <span className="flex items-center gap-1">
                            <Mail className="h-3 w-3" />
                            <span className="hidden md:inline">{contact.email}</span>
                          </span>
                        )}
                        {contact.phone && (
                          <span className="flex items-center gap-1">
                            <Phone className="h-3 w-3" />
                            <span className="hidden lg:inline">{contact.phone}</span>
                          </span>
                        )}
                      </div>

                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteContact(contact.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    {/* Expanded Messages */}
                    {expandedContact === contact.id && (
                      <div className="border-t bg-muted/20 p-4">
                        {loadingDetails === contact.id ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                          </div>
                        ) : contactDetails[contact.id]?.messages.length === 0 ? (
                          <div className="text-center py-8 text-muted-foreground">
                            <MessageSquare className="mx-auto h-8 w-8 mb-2 opacity-50" />
                            <p className="text-sm">No communication history</p>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <h4 className="font-medium text-sm flex items-center gap-2">
                              <MessageSquare className="h-4 w-4" />
                              Communication History ({contactDetails[contact.id]?.messages.length || 0})
                            </h4>
                            <ScrollArea className="h-[300px]">
                              <div className="space-y-3 pr-4">
                                {contactDetails[contact.id]?.messages.map((message) => (
                                  <div
                                    key={message.id}
                                    className={cn(
                                      "p-3 rounded-lg border",
                                      message.direction === 'inbound'
                                        ? "bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800"
                                        : "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800"
                                    )}
                                  >
                                    <div className="flex items-center justify-between mb-2">
                                      <Badge
                                        variant="outline"
                                        className={cn(
                                          "text-[10px]",
                                          message.direction === 'inbound'
                                            ? "bg-blue-100 text-blue-700 border-blue-300"
                                            : "bg-green-100 text-green-700 border-green-300"
                                        )}
                                      >
                                        {message.direction === 'inbound' ? 'Received' : 'Sent'}
                                      </Badge>
                                      {message.sent_at && (
                                        <span className="text-xs text-muted-foreground">
                                          {format(new Date(message.sent_at), 'PPp')}
                                        </span>
                                      )}
                                    </div>
                                    {message.subject && (
                                      <p className="font-medium text-sm">{message.subject}</p>
                                    )}
                                    {(message.from_email || message.to_email) && (
                                      <div className="mt-2 pt-2 border-t text-xs text-muted-foreground">
                                        {message.from_email && <p>From: {message.from_email}</p>}
                                        {message.to_email && <p>To: {message.to_email}</p>}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </ScrollArea>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
